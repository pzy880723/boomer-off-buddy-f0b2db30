-- 0080 夹具：handheld_smart_create_commit 的最小替身（同一事务插入 SKU、按 client_op_id 回放）。
-- 真实函数还做 EPC/入库/有赞 outbox；这里只验证 v2 包装在同事务持久化图片计划与入队，不触达任何外部系统。
CREATE TABLE IF NOT EXISTS public.t_smart_ops (client_op_id text PRIMARY KEY, sku_id uuid NOT NULL);
CREATE OR REPLACE FUNCTION public.handheld_smart_create_commit(p_device_id uuid, p_user_id uuid, p_client_op_id text,
  p_fingerprint text, p_location_id uuid, p_reuse boolean, p_sku jsonb, p_epcs text[], p_note text, p_release_shop_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  SELECT sku_id INTO v_id FROM t_smart_ops WHERE client_op_id = p_client_op_id;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('sku_id', v_id, 'replayed', true, 'response', NULL); END IF;
  INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price, image_paths)
  VALUES ((p_sku->>'id')::uuid, p_sku->>'category', 100, p_sku->>'name', p_sku->>'id', true,
          ARRAY(SELECT jsonb_array_elements_text(p_sku->'image_paths')))
  RETURNING id INTO v_id;
  INSERT INTO t_smart_ops VALUES (p_client_op_id, v_id);
  RETURN jsonb_build_object('sku_id', v_id, 'replayed', false, 'response', NULL);
END $$;
