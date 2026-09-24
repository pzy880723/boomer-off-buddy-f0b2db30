-- 事故修复：未使用零库存 SKU 的安全删除（仅总部）；直连 DELETE 策略同口径收紧。
-- 不删除流水、不级联同步映射：存在任何业务引用即拒绝。

CREATE OR REPLACE FUNCTION public.inv_sku_is_hq_actor()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(auth.role(), '') = 'service_role'
      OR (auth.uid() IS NOT NULL AND (
            public.has_role(auth.uid(), 'super_admin'::public.app_role)
         OR public.has_role(auth.uid(), 'hq_operator'::public.app_role)));
$$;

CREATE OR REPLACE FUNCTION public.inv_sku_delete_blocker(p_sku_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_qty integer;
  v_hit boolean;
  r record;
BEGIN
  SELECT stock_qty INTO v_qty FROM public.inv_skus WHERE id = p_sku_id;
  IF NOT FOUND THEN RETURN '商品不存在'; END IF;
  IF COALESCE(v_qty, 0) <> 0 THEN RETURN '商品仍有库存（总库存非零），不能删除'; END IF;
  IF EXISTS (SELECT 1 FROM public.inv_stocks WHERE sku_id = p_sku_id AND qty <> 0) THEN
    RETURN '商品在门店或仓库仍有库存，不能删除';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('inv_stock_movements','sku_id','商品已有库存流水，请归档而不是删除'),
    ('inv_inbound_lines','sku_id','商品存在入库记录，请归档而不是删除'),
    ('stock_transfers','from_sku_id','商品存在调拨记录，请归档而不是删除'),
    ('stock_transfers','to_sku_id','商品存在调拨记录，请归档而不是删除'),
    ('stock_transfer_lines','sku_id','商品存在调拨记录，请归档而不是删除'),
    ('stock_transfer_epcs','sku_id','商品存在调拨记录，请归档而不是删除'),
    ('stocktake_lines','sku_id','商品存在盘点记录，请归档而不是删除'),
    ('stocktake_scans','sku_id','商品存在盘点记录，请归档而不是删除'),
    ('inventory_sale_events','sku_id','商品存在销售记录，请归档而不是删除'),
    ('inventory_reservations','sku_id','商品存在预占记录，不能删除'),
    ('inventory_reservation_lines','stock_sku_id','商品存在预占记录，不能删除'),
    ('commerce_listings','sku_id','商品已在商城上架或有上架历史，请归档而不是删除'),
    ('commerce_order_items','sku_id','商品存在订单记录，请归档而不是删除'),
    ('fulfillment_items','sku_id','商品存在履约记录，请归档而不是删除'),
    ('pos_held_cart_items','sku_id','商品在收银挂单中，不能删除'),
    ('pos_return_items','sku_id','商品存在退货记录，请归档而不是删除'),
    ('return_inspections','sku_id','商品存在退货检验记录，请归档而不是删除'),
    ('sku_youzan_links','sku_id','商品已有有赞关联，请先处理有赞商品再删除'),
    ('youzan_stock_sync_queue','sku_id','商品有有赞库存同步任务，不能删除'),
    ('sku_channel_listings','sku_id','商品已有渠道上架记录，请先处理渠道商品再删除'),
    ('channel_sync_outbox','sku_id','商品有渠道同步任务，不能删除'),
    ('inv_epcs','sku_id','商品已绑定 RFID 标签，请归档而不是删除')
  ) AS t(tbl, col, msg) LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I = $1)', r.tbl, r.col)
      INTO v_hit USING p_sku_id;
    IF v_hit THEN RETURN r.msg; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.inv_skus s
    WHERE s.id <> p_sku_id AND jsonb_typeof(s.bundle_items) = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.bundle_items) e WHERE e->>'sku_id' = p_sku_id::text)
  ) THEN
    RETURN '商品是其他组合商品的组成部分，不能删除';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_delete_unused_sku(p_sku_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blocker text;
BEGIN
  IF NOT public.inv_sku_is_hq_actor() THEN
    RAISE EXCEPTION '仅总部管理员可以删除商品' USING ERRCODE = '42501';
  END IF;
  -- 行锁：引用该 SKU 的插入需 KEY SHARE，与 FOR UPDATE 互斥，库存写入与删除串行。
  PERFORM 1 FROM public.inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '商品不存在' USING ERRCODE = 'P0002';
  END IF;
  v_blocker := public.inv_sku_delete_blocker(p_sku_id);
  IF v_blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', v_blocker USING ERRCODE = 'P0001', DETAIL = 'sku_in_use';
  END IF;
  DELETE FROM public.inv_skus WHERE id = p_sku_id;
  RETURN jsonb_build_object('ok', true, 'deleted_sku_id', p_sku_id);
END;
$$;

REVOKE ALL ON FUNCTION public.inv_sku_is_hq_actor() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.inv_sku_delete_blocker(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.inventory_delete_unused_sku(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_sku_is_hq_actor() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inv_sku_delete_blocker(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.inventory_delete_unused_sku(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS auth_delete_inv_skus ON public.inv_skus;
CREATE POLICY auth_delete_inv_skus ON public.inv_skus
  FOR DELETE TO authenticated
  USING (public.inv_sku_is_hq_actor() AND public.inv_sku_delete_blocker(id) IS NULL);