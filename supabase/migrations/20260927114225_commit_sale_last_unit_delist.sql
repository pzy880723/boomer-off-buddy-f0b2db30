-- Only exhausted inventory is sold/delisted. No historical rows are rewritten.
CREATE OR REPLACE FUNCTION public.commit_sale(
  p_sku_id uuid,
  p_source_channel text,
  p_source_order_id text,
  p_source_shop_id uuid DEFAULT NULL,
  p_event_type text DEFAULT 'sale',
  p_epc text DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_raw_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.inventory_sale_events%ROWTYPE;
  v_sku public.inv_skus%ROWTYPE;
  v_location_qty integer;
  v_remaining bigint;
  v_exhausted boolean;
  v_new_version bigint;
  v_event_id uuid;
  v_listing record;
BEGIN
  SELECT * INTO v_existing FROM public.inventory_sale_events
   WHERE source_channel = p_source_channel
     AND source_order_id = p_source_order_id
     AND event_type = p_event_type;
  IF FOUND AND (v_existing.status <> 'oversold' OR v_existing.sku_id IS DISTINCT FROM p_sku_id) THEN
    RETURN jsonb_build_object(
      'ok', v_existing.status = 'processed',
      'idempotent', true,
      'event_id', v_existing.id,
      'status', v_existing.status
    );
  END IF;

  SELECT * INTO v_sku FROM public.inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.inventory_sale_events
      (source_channel, source_shop_id, source_order_id, event_type,
       sku_id, epc, raw_payload, status, error, processed_at)
    VALUES (p_source_channel, p_source_shop_id, p_source_order_id, p_event_type,
            p_sku_id, p_epc, p_raw_payload, 'unmatched', 'sku not found', now())
    RETURNING id INTO v_event_id;
    RETURN jsonb_build_object('ok', false, 'error', 'sku_not_found', 'event_id', v_event_id);
  END IF;

  -- A concurrent delivery may have committed while this transaction waited.
  SELECT * INTO v_existing FROM public.inventory_sale_events
   WHERE source_channel = p_source_channel
     AND source_order_id = p_source_order_id
     AND event_type = p_event_type
   FOR UPDATE;
  IF FOUND THEN
    -- Old code rejected unlimited SKUs with no physical stock. Repair only this
    -- replayed event, under both locks, without inventing a stock movement.
    IF v_existing.status = 'oversold'
       AND v_existing.sku_id = p_sku_id
       AND v_sku.inventory_policy = 'unlimited'
       AND NOT EXISTS (
         SELECT 1 FROM public.inv_stock_movements
          WHERE sku_id = p_sku_id
            AND (ref_id = v_existing.id OR (
              ref_type = 'sale:' || p_source_channel
              AND note = 'commit_sale ' || p_source_order_id))
       ) THEN
      UPDATE public.inventory_sale_events
         SET status = 'processed', error = NULL, processed_at = now(),
             raw_payload = jsonb_build_object(
               'original_raw_payload', v_existing.raw_payload,
               'unlimited_oversold_replay', jsonb_build_object(
                 'original_status', v_existing.status,
                 'original_error', v_existing.error,
                 'original_processed_at', v_existing.processed_at,
                 'replayed_at', now(),
                 'replay_raw_payload', p_raw_payload))
       WHERE id = v_existing.id
      RETURNING * INTO v_existing;
    END IF;
    RETURN jsonb_build_object(
      'ok', v_existing.status = 'processed',
      'idempotent', true,
      'event_id', v_existing.id,
      'status', v_existing.status
    );
  END IF;

  IF p_location_id IS NOT NULL THEN
    SELECT qty INTO v_location_qty
      FROM public.inv_stocks
     WHERE sku_id = p_sku_id
       AND location_id = p_location_id
     FOR UPDATE;
  END IF;

  IF (v_sku.inventory_policy <> 'unlimited' AND (
       (p_location_id IS NOT NULL AND COALESCE(v_location_qty, 0) < 1)
       OR (p_location_id IS NULL AND v_sku.stock_qty < 1)))
     OR v_sku.sales_state IN ('sold','sold_syncing','retired') THEN
    INSERT INTO public.inventory_sale_events
      (source_channel, source_shop_id, source_order_id, event_type,
       sku_id, epc, raw_payload, status, error, processed_at)
    VALUES (p_source_channel, p_source_shop_id, p_source_order_id, p_event_type,
            p_sku_id, p_epc, p_raw_payload, 'oversold',
            'insufficient stock or already sold', now())
    RETURNING id INTO v_event_id;
    RETURN jsonb_build_object('ok', false, 'error', 'oversold', 'event_id', v_event_id);
  END IF;

  IF p_location_id IS NOT NULL THEN
    PERFORM public.inv_apply_movement(
      p_sku_id, p_location_id, -1,
      'sale:' || p_source_channel, NULL, p_epc,
      'commit_sale ' || p_source_order_id
    );
  ELSIF v_sku.inventory_policy <> 'unlimited' THEN
    UPDATE public.inv_skus SET stock_qty = GREATEST(0, stock_qty - 1), updated_at = now()
     WHERE id = p_sku_id;
    INSERT INTO public.inv_stock_movements
      (sku_id, location_id, delta, balance_after, ref_type, ref_id, epc, note, created_by)
    VALUES (p_sku_id, NULL, -1, GREATEST(0, v_sku.stock_qty - 1),
            'sale:' || p_source_channel, NULL, p_epc,
            'commit_sale ' || p_source_order_id, auth.uid());
  END IF;

  -- Shop movements do not roll up inv_skus.stock_qty; use actual location stock.
  -- Negative discrepancies must not cancel stock still available elsewhere.
  SELECT COALESCE(sum(GREATEST(qty, 0)), 0) INTO v_remaining
    FROM public.inv_stocks WHERE sku_id = p_sku_id;
  IF p_location_id IS NULL THEN
    -- Legacy callers debit the aggregate only. Retain either positive source.
    v_remaining := GREATEST(v_remaining, v_sku.stock_qty - 1);
  END IF;
  v_exhausted := v_sku.inventory_policy <> 'unlimited' AND v_remaining = 0;

  UPDATE public.inv_skus
     SET inventory_version = inventory_version + 1,
         sales_state = CASE WHEN v_exhausted THEN 'sold_syncing' ELSE sales_state END,
         is_display = CASE WHEN v_exhausted THEN false ELSE is_display END,
         stock_qty = CASE WHEN v_exhausted AND is_custom_price THEN 0 ELSE stock_qty END,
         updated_at = now()
   WHERE id = p_sku_id
  RETURNING inventory_version INTO v_new_version;

  INSERT INTO public.inventory_sale_events
    (source_channel, source_shop_id, source_order_id, event_type,
     sku_id, epc, raw_payload, status, processed_at)
  VALUES (p_source_channel, p_source_shop_id, p_source_order_id, p_event_type,
          p_sku_id, p_epc, p_raw_payload, 'processed', now())
  RETURNING id INTO v_event_id;

  IF v_exhausted THEN
    UPDATE public.commerce_listings
       SET status = 'sold',
           sold_at = COALESCE(sold_at, now()),
           updated_at = now()
     WHERE sku_id = p_sku_id
       AND product_type = 'custom'
       AND status IN ('draft','published','reserved');

    FOR v_listing IN
      SELECT id, channel, shop_id FROM public.sku_channel_listings
       WHERE sku_id = p_sku_id
         AND listing_status IN ('published','shelved','unshelved')
    LOOP
      INSERT INTO public.channel_sync_outbox
        (sku_id, channel_listing_id, channel, shop_id, action,
         priority, inventory_version, target_stock, dedupe_key)
      VALUES (p_sku_id, v_listing.id, v_listing.channel, v_listing.shop_id,
              'set_stock_zero', 1, v_new_version, 0,
              p_sku_id::text || ':' || v_listing.id::text || ':set_stock_zero:' || v_new_version::text)
      ON CONFLICT (dedupe_key) DO NOTHING;

      INSERT INTO public.channel_sync_outbox
        (sku_id, channel_listing_id, channel, shop_id, action,
         priority, inventory_version, dedupe_key)
      VALUES (p_sku_id, v_listing.id, v_listing.channel, v_listing.shop_id,
              'delist', 1, v_new_version,
              p_sku_id::text || ':' || v_listing.id::text || ':delist:' || v_new_version::text)
      ON CONFLICT (dedupe_key) DO NOTHING;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'inventory_version', v_new_version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commit_sale(uuid, text, text, uuid, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_sale(uuid, text, text, uuid, text, text, uuid, jsonb) TO service_role;
