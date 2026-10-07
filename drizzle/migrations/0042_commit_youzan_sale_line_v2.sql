-- commit_youzan_sale_line v2：订单锁内识别行重排后的旧下标事件（歧义拒绝）、未处理事件不算已扣、失败事件有界可重试。
-- 仍通过 commit_sale 完成全部库存校验与扣减，不直接改库存。
CREATE OR REPLACE FUNCTION public.commit_youzan_sale_line(
  p_sku_id uuid, p_source_channel text, p_source_order_id text, p_legacy_order_id text DEFAULT NULL,
  p_source_shop_id uuid DEFAULT NULL, p_location_id uuid DEFAULT NULL, p_raw_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tid text := split_part(p_source_order_id, '#', 1);
  v_unit text := split_part(p_source_order_id, '#', 3);
  v_item text := p_raw_payload->>'item_id';
  v_ev public.inventory_sale_events%ROWTYPE;
  v_legacy_n int;
  v_other_oid_n int;
  v_retries int;
BEGIN
  IF p_source_channel NOT IN ('youzan_branch_offline','youzan_online') THEN RAISE EXCEPTION 'unsupported channel'; END IF;
  IF p_source_order_id !~ '^[A-Za-z0-9_-]+#(oid:[A-Za-z0-9_-]+|[0-9]+)#[0-9]+$' THEN RAISE EXCEPTION 'invalid source order id'; END IF;
  IF p_legacy_order_id IS NOT NULL AND p_legacy_order_id !~ '^[A-Za-z0-9_-]+#[0-9]+#[0-9]+$' THEN RAISE EXCEPTION 'invalid legacy order id'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_source_channel || ':' || v_tid));

  SELECT * INTO v_ev FROM public.inventory_sale_events
   WHERE source_channel = p_source_channel AND source_order_id = p_source_order_id AND event_type = 'paid' FOR UPDATE;
  IF FOUND THEN
    IF v_ev.status = 'processed' OR v_ev.status NOT IN ('oversold','unmatched') THEN
      RETURN jsonb_build_object('ok', v_ev.status = 'processed', 'idempotent', true, 'event_id', v_ev.id, 'status', v_ev.status);
    END IF;
    SELECT count(*) INTO v_retries FROM public.inventory_sale_events
     WHERE source_channel = p_source_channel AND event_type = 'paid' AND source_order_id LIKE p_source_order_id || '~retry%';
    IF v_retries >= 5 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'retry_exhausted', 'event_id', v_ev.id, 'status', v_ev.status);
    END IF;
    UPDATE public.inventory_sale_events
       SET source_order_id = p_source_order_id || '~retry' || (v_retries + 1),
           raw_payload = jsonb_build_object('superseded_by_retry', true, 'original_raw_payload', raw_payload)
     WHERE id = v_ev.id;
  END IF;

  IF p_source_order_id LIKE '%#oid:%' THEN
    IF p_legacy_order_id IS NOT NULL THEN
      SELECT * INTO v_ev FROM public.inventory_sale_events
       WHERE source_channel = p_source_channel AND source_order_id = p_legacy_order_id
         AND event_type = 'paid' AND sku_id = p_sku_id AND status = 'processed';
      IF FOUND THEN
        RETURN jsonb_build_object('ok', true, 'idempotent', true, 'event_id', v_ev.id, 'status', v_ev.status, 'legacy_key', true);
      END IF;
    END IF;
    SELECT count(*), min(id::text) INTO v_legacy_n, v_ev.id FROM public.inventory_sale_events
     WHERE source_channel = p_source_channel AND event_type = 'paid' AND status = 'processed' AND sku_id = p_sku_id
       AND split_part(source_order_id, '#', 1) = v_tid
       AND split_part(source_order_id, '#', 2) ~ '^[0-9]+$'
       AND split_part(source_order_id, '#', 3) = v_unit
       AND (v_item IS NULL OR raw_payload->>'item_id' IS NULL OR raw_payload->>'item_id' = v_item);
    IF v_legacy_n > 0 THEN
      SELECT count(*) INTO v_other_oid_n FROM public.inventory_sale_events
       WHERE source_channel = p_source_channel AND event_type = 'paid' AND status = 'processed' AND sku_id = p_sku_id
         AND split_part(source_order_id, '#', 1) = v_tid
         AND split_part(source_order_id, '#', 2) LIKE 'oid:%'
         AND split_part(source_order_id, '#', 3) = v_unit
         AND source_order_id <> p_source_order_id;
      IF v_legacy_n = 1 AND v_other_oid_n = 0 THEN
        RETURN jsonb_build_object('ok', true, 'idempotent', true, 'event_id', v_ev.id, 'status', 'processed', 'legacy_key', true, 'legacy_reordered', true);
      END IF;
      RETURN jsonb_build_object('ok', false, 'error', 'ambiguous_legacy', 'legacy_candidates', v_legacy_n, 'other_oid_events', v_other_oid_n);
    END IF;
  END IF;

  RETURN public.commit_sale(p_sku_id, p_source_channel, p_source_order_id, p_source_shop_id, 'paid', NULL, p_location_id, p_raw_payload);
END $$;
REVOKE ALL ON FUNCTION public.commit_youzan_sale_line(uuid, text, text, text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_youzan_sale_line(uuid, text, text, text, uuid, uuid, jsonb) TO service_role;