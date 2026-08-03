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
  v_new_version bigint;
  v_event_id uuid;
  v_listing record;
BEGIN
  SELECT * INTO v_existing FROM public.inventory_sale_events
   WHERE source_channel = p_source_channel
     AND source_order_id = p_source_order_id
     AND event_type = p_event_type;
  IF FOUND THEN
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

  IF v_sku.stock_qty < 1 OR v_sku.sales_state IN ('sold','sold_syncing','retired') THEN
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
  ELSE
    UPDATE public.inv_skus SET stock_qty = GREATEST(0, stock_qty - 1), updated_at = now()
     WHERE id = p_sku_id;
    INSERT INTO public.inv_stock_movements
      (sku_id, location_id, delta, balance_after, ref_type, ref_id, epc, note, created_by)
    VALUES (p_sku_id, NULL, -1, GREATEST(0, v_sku.stock_qty - 1),
            'sale:' || p_source_channel, NULL, p_epc,
            'commit_sale ' || p_source_order_id, auth.uid());
  END IF;

  UPDATE public.inv_skus
     SET inventory_version = inventory_version + 1,
         sales_state = 'sold_syncing',
         updated_at = now()
   WHERE id = p_sku_id
  RETURNING inventory_version INTO v_new_version;

  INSERT INTO public.inventory_sale_events
    (source_channel, source_shop_id, source_order_id, event_type,
     sku_id, epc, raw_payload, status, processed_at)
  VALUES (p_source_channel, p_source_shop_id, p_source_order_id, p_event_type,
          p_sku_id, p_epc, p_raw_payload, 'processed', now())
  RETURNING id INTO v_event_id;

  -- BOOMEROFF 市集：唯一件卖掉后立刻标记售罄（只影响自定义商品的 listing）
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

  RETURN jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'inventory_version', v_new_version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.commit_sale(uuid, text, text, uuid, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_sale(uuid, text, text, uuid, text, text, uuid, jsonb) TO service_role;