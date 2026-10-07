CREATE OR REPLACE FUNCTION public.commit_youzan_sale_line(
  p_sku_id uuid,
  p_source_channel text,
  p_source_order_id text,
  p_legacy_order_id text DEFAULT NULL,
  p_source_shop_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_raw_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_legacy public.inventory_sale_events%ROWTYPE;
BEGIN
  IF p_source_channel NOT IN ('youzan_branch_offline','youzan_online') THEN
    RAISE EXCEPTION 'unsupported channel';
  END IF;
  IF p_source_order_id !~ '^[A-Za-z0-9_-]+#(oid:[A-Za-z0-9_-]+|[0-9]+)#[0-9]+$' THEN
    RAISE EXCEPTION 'invalid source order id';
  END IF;
  -- 同一订单的旧下标键与新 oid 键串行处理，防止并发重放双扣。
  PERFORM pg_advisory_xact_lock(hashtext(p_source_channel || ':' || split_part(p_source_order_id, '#', 1)));
  IF p_legacy_order_id IS NOT NULL AND p_legacy_order_id <> p_source_order_id THEN
    SELECT * INTO v_legacy FROM public.inventory_sale_events
     WHERE source_channel = p_source_channel
       AND source_order_id = p_legacy_order_id
       AND event_type = 'paid'
       AND sku_id = p_sku_id;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', v_legacy.status = 'processed', 'idempotent', true,
        'event_id', v_legacy.id, 'status', v_legacy.status, 'legacy_key', true);
    END IF;
  END IF;
  RETURN public.commit_sale(p_sku_id, p_source_channel, p_source_order_id, p_source_shop_id,
                            'paid', NULL, p_location_id, p_raw_payload);
END $$;
REVOKE ALL ON FUNCTION public.commit_youzan_sale_line(uuid, text, text, text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_youzan_sale_line(uuid, text, text, text, uuid, uuid, jsonb) TO service_role;