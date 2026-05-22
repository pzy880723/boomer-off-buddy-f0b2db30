
-- ============================================================
-- 锁定所有业务表 RLS：从 public → authenticated
-- 所有员工都需登录使用后台；浏览器端 supabase 客户端已携带 JWT
-- 服务端 serverFn 使用 supabaseAdmin 绕过 RLS，不受影响
-- ============================================================

-- 通用函数：drop + recreate as authenticated
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'domestic_bulk_order_lines','domestic_bulk_orders','domestic_orders',
    'inv_inbound_lines','inv_inbound_orders','inv_label_batches','inv_skus',
    'japan_parcel_items','japan_parcels',
    'meruki_accounts','meruki_raw_captures','meruki_sync_runs',
    'stock_transfers','youzan_items','youzan_orders','youzan_shops','youzan_sync_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS open_select_%I ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS open_insert_%I ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS open_update_%I ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS open_delete_%I ON public.%I', t, t);

    EXECUTE format('CREATE POLICY auth_select_%I ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('CREATE POLICY auth_insert_%I ON public.%I FOR INSERT TO authenticated WITH CHECK (true)', t, t);
    EXECUTE format('CREATE POLICY auth_update_%I ON public.%I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)', t, t);
    EXECUTE format('CREATE POLICY auth_delete_%I ON public.%I FOR DELETE TO authenticated USING (true)', t, t);
  END LOOP;
END$$;

-- ============================================================
-- 存储桶策略：写入/更新/删除收紧到 authenticated
-- parcel-item-images 保留公开 SELECT（图片需在前端渲染）
-- domestic-order-screenshots / domestic-bulk-attachments 含敏感截图与合同附件，SELECT 也改 authenticated
-- ============================================================

DROP POLICY IF EXISTS parcel_item_images_public_read   ON storage.objects;
DROP POLICY IF EXISTS parcel_item_images_public_insert ON storage.objects;
DROP POLICY IF EXISTS parcel_item_images_public_update ON storage.objects;
DROP POLICY IF EXISTS parcel_item_images_public_delete ON storage.objects;

CREATE POLICY parcel_item_images_read ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'parcel-item-images');
CREATE POLICY parcel_item_images_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'parcel-item-images');
CREATE POLICY parcel_item_images_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'parcel-item-images');
CREATE POLICY parcel_item_images_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'parcel-item-images');

DROP POLICY IF EXISTS "Public read domestic screenshots"   ON storage.objects;
DROP POLICY IF EXISTS "Public upload domestic screenshots" ON storage.objects;
DROP POLICY IF EXISTS "Public update domestic screenshots" ON storage.objects;
DROP POLICY IF EXISTS "Public delete domestic screenshots" ON storage.objects;

CREATE POLICY domestic_screenshots_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'domestic-order-screenshots');
CREATE POLICY domestic_screenshots_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'domestic-order-screenshots');
CREATE POLICY domestic_screenshots_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'domestic-order-screenshots');
CREATE POLICY domestic_screenshots_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'domestic-order-screenshots');

DROP POLICY IF EXISTS domestic_bulk_attachments_select ON storage.objects;
DROP POLICY IF EXISTS domestic_bulk_attachments_insert ON storage.objects;
DROP POLICY IF EXISTS domestic_bulk_attachments_update ON storage.objects;
DROP POLICY IF EXISTS domestic_bulk_attachments_delete ON storage.objects;

CREATE POLICY domestic_bulk_attachments_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'domestic-bulk-attachments');
CREATE POLICY domestic_bulk_attachments_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'domestic-bulk-attachments');
CREATE POLICY domestic_bulk_attachments_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'domestic-bulk-attachments');
CREATE POLICY domestic_bulk_attachments_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'domestic-bulk-attachments');

-- 将敏感桶改为非公开（仍可生成签名 URL 访问）
UPDATE storage.buckets SET public = false
  WHERE id IN ('domestic-order-screenshots','domestic-bulk-attachments');

-- ============================================================
-- SECURITY DEFINER 函数：从 anon 撤销 EXECUTE；只允许 authenticated/service_role
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.inv_apply_inbound_stock(uuid, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.inv_apply_stock_delta(uuid, integer)  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.gen_stock_transfer_code()             FROM PUBLIC, anon;

GRANT  EXECUTE ON FUNCTION public.inv_apply_inbound_stock(uuid, integer) TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.inv_apply_stock_delta(uuid, integer)  TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.gen_stock_transfer_code()             TO authenticated, service_role;

-- 修复 tg_set_updated_at 的可变 search_path
CREATE OR REPLACE FUNCTION public.tg_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$;
