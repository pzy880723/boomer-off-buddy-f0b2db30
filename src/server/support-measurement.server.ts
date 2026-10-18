import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { cardAuthorized, safeMeasurementImage, type MeasurementCard, type CardTask } from '@/lib/measurement-card';
import { loadConversationThumbnails } from './support-thumbnails.server';
type Conversation = {id:string;customer_id:string|null;location_id:string|null};
/** Only called after exact conversation authorization. Task/store/requester are rechecked before images. */
export async function loadMeasurementCards(conversation: Conversation, taskIds: string[]): Promise<Map<string,MeasurementCard>> {
  const cards = new Map<string,MeasurementCard>();
  if (!taskIds.length || !conversation.customer_id) return cards;
  const [tasks,requesters] = await Promise.all([
    supabaseAdmin.from('product_measurement_tasks').select('id,sku_id,listing_id,location_id,status').in('id',taskIds),
    supabaseAdmin.from('product_measurement_requesters').select('task_id,customer_id,conversation_id').eq('customer_id',conversation.customer_id).eq('conversation_id',conversation.id).in('task_id',taskIds),
  ]);
  if (tasks.error || requesters.error) throw new Error('measurement_card_unavailable');
  const allowed = (tasks.data ?? []).filter(t=>cardAuthorized(t as CardTask,conversation,requesters.data ?? []));
  if (!allowed.length) return cards;
  const skus = await supabaseAdmin.from('inv_skus').select('id,name,measurement_revision,measured_at,measurement_height_cm,measurement_width_cm,measurement_depth_cm,measurement_diameter_cm').in('id',[...new Set(allowed.map(t=>t.sku_id))]);
  if(skus.error) throw new Error('measurement_card_unavailable');
  const images = await loadConversationThumbnails(allowed.map(t=>({id:t.id,context:{type:'product',id:t.listing_id}})),conversation.customer_id);
  for(const t of allowed) {
    const sku = skus.data?.find(s=>s.id===t.sku_id);
    if(!sku || !['pending','claimed','completed','cancelled'].includes(t.status)) continue;
    cards.set(t.id,{task_id:t.id,sku_id:t.sku_id,listing_id:t.listing_id,product_name:sku.name ?? '商品',
      image_url:safeMeasurementImage(images.get(t.id)),status:t.status as MeasurementCard['status'],measurement_revision:sku.measurement_revision,
      ...(sku.measured_at ? {measurement:{height_cm:sku.measurement_height_cm,width_cm:sku.measurement_width_cm,depth_cm:sku.measurement_depth_cm,diameter_cm:sku.measurement_diameter_cm}} : {}),
    });
  }
  return cards;
}
export async function pendingConversationStates(ids: string[]) {
  return new Map(await Promise.all(ids.map(async id=> {
    const {data,error}=await supabaseAdmin.rpc('support_pending_state' as never,{p_conversation_id:id} as never);
    if(error) throw new Error('support_pending_unavailable');
    return [id,data as {needs_reply:boolean;pending_measurement_count:number;pending_action:boolean}] as const;
  })));
}
