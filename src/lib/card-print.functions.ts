import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { projectQr, type QrRecord } from './card-print/qr-policy';

// PC authentication does not borrow a handheld device token. Same role/location and QR read contract.
export const readCardPrintContext = createServerFn({ method: 'GET' })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ location_id: z.string().uuid('请选择有效门店').optional() }).strict().parse(input))
  .handler(async ({ data, context }) => {
    const rolesResult = await context.supabase.from('user_roles').select('role').eq('user_id', context.userId);
    if (rolesResult.error) throw new Error('无法核对门店权限');
    const hq = rolesResult.data.some(r => r.role === 'super_admin' || r.role === 'hq_operator');
    let ids: string[] | null = null;
    if (!hq) {
      const perms = await context.supabase.from('user_location_perms').select('location_id').eq('user_id', context.userId);
      if (perms.error) throw new Error('无法核对门店权限');
      ids = perms.data.map(p => p.location_id);
      if (!ids.length) return { locations: [], channels: [] };
      if (data.location_id && !ids.includes(data.location_id)) throw new Error('无权读取此门店');
    }
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    let query = supabaseAdmin.from('inv_locations').select('id,name').eq('kind', 'shop').eq('is_active', true).order('name');
    if (ids) query = query.in('id', ids);
    const stores = await query;
    if (stores.error) throw new Error('无法读取门店');
    if (!data.location_id) return { locations: stores.data, channels: [] };
    if (!stores.data.some(s => s.id === data.location_id)) throw new Error('门店已停用或不可访问');
    const rows = await supabaseAdmin.from('store_qr_configs').select('purpose,status,image_bucket,image_path,updated_at').eq('location_id', data.location_id);
    if (rows.error) throw new Error('无法读取门店二维码');
    const images = await projectQr(rows.data as QrRecord[], data.location_id, async path => {
      const signed = await supabaseAdmin.storage.from('store-qr').createSignedUrl(path, 300);
      return signed.error ? null : signed.data.signedUrl;
    });
    return { locations: stores.data, channels: images };
  });
