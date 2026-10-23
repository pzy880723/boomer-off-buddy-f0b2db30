CREATE OR REPLACE FUNCTION public.handheld_smart_create_commit(p_device_id uuid, p_user_id uuid, p_client_op_id text, p_fingerprint text, p_location_id uuid, p_reuse boolean, p_sku jsonb, p_epcs text[], p_note text, p_release_shop_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op public.handheld_smart_create_ops;
  v_op_id uuid;
  v_sku public.inv_skus;
  v_epc text;
  v_bound integer := 0;
  v_qty integer;
BEGIN
  IF p_device_id IS NULL OR p_user_id IS NULL OR p_location_id IS NULL OR coalesce(p_fingerprint,'') = '' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;

  IF p_client_op_id IS NOT NULL THEN
    -- 并发同 op：后到者在唯一索引上等待先到事务提交/回滚
    INSERT INTO public.handheld_smart_create_ops (device_id, client_op_id, user_id, location_id, payload_fingerprint)
    VALUES (p_device_id, p_client_op_id, p_user_id, p_location_id, p_fingerprint)
    ON CONFLICT (device_id, client_op_id) DO NOTHING
    RETURNING id INTO v_op_id;

    IF v_op_id IS NULL THEN
      SELECT * INTO v_op FROM public.handheld_smart_create_ops
        WHERE device_id = p_device_id AND client_op_id = p_client_op_id FOR UPDATE;
      IF v_op.user_id <> p_user_id OR v_op.location_id <> p_location_id
         OR v_op.payload_fingerprint <> p_fingerprint THEN
        RAISE EXCEPTION 'client_op_id_conflict' USING ERRCODE = 'P0409';
      END IF;
      SELECT * INTO v_sku FROM public.inv_skus WHERE id = v_op.sku_id;
      RETURN jsonb_build_object(
        'op_id', v_op.id, 'replayed', true, 'op_status', v_op.status,
        'sku_id', v_op.sku_id, 'sku_code', v_sku.sku_code, 'epc', v_sku.epc,
        'bound_epcs', v_op.bound_epcs, 'stock_qty', v_op.stock_qty,
        'response', v_op.response_json);
    END IF;
  END IF;

  IF p_reuse THEN
    SELECT * INTO v_sku FROM public.inv_skus
      WHERE category = p_sku->>'category'
        AND price_tier = (p_sku->>'price_tier')::numeric
        AND name = p_sku->>'name'
      ORDER BY created_at LIMIT 1 FOR UPDATE;
  END IF;

  IF v_sku.id IS NULL THEN
    INSERT INTO public.inv_skus (
      category, name, price_tier, is_custom_price, inventory_policy, kind, epc, sku_code,
      image_paths, image_url, weight_g, notes, grade, attributes, category_source,
      category_confidence, classification_status, ai_suggested_price, recognition_request_id,
      ip_id, ip_candidate_text, fankuang_override, stock_qty, status)
    VALUES (
      p_sku->>'category', p_sku->>'name', (p_sku->>'price_tier')::numeric,
      coalesce((p_sku->>'is_custom_price')::boolean, false),
      coalesce(p_sku->>'inventory_policy', 'tracked'), 'single', p_sku->>'epc', p_sku->>'sku_code',
      coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p_sku->'image_paths','[]'::jsonb))), '{}'),
      p_sku->>'image_url', (p_sku->>'weight_g')::numeric, p_sku->>'notes', p_sku->>'grade',
      coalesce(p_sku->'attributes', '{}'::jsonb), coalesce(p_sku->>'category_source','manual'),
      (p_sku->>'category_confidence')::numeric, coalesce(p_sku->>'classification_status','legacy'),
      (p_sku->>'ai_suggested_price')::numeric, (p_sku->>'recognition_request_id')::uuid,
      (p_sku->>'ip_id')::uuid, p_sku->>'ip_candidate_text',
      CASE WHEN jsonb_typeof(p_sku->'fankuang_override') = 'boolean' THEN (p_sku->>'fankuang_override')::boolean END,
      0, 'active')
    RETURNING * INTO v_sku;
  END IF;

  FOREACH v_epc IN ARRAY coalesce(p_epcs, '{}'::text[]) LOOP
    INSERT INTO public.inv_epcs (epc, sku_id, status, current_location_id, last_seen_at)
    VALUES (v_epc, v_sku.id, 'in_stock', p_location_id, now())
    ON CONFLICT (epc) DO UPDATE SET sku_id = EXCLUDED.sku_id, status = 'in_stock',
      current_location_id = EXCLUDED.current_location_id, last_seen_at = now(), updated_at = now();
    v_bound := v_bound + 1;
  END LOOP;

  v_qty := public.inv_apply_movement(v_sku.id, p_location_id, 1 + v_bound,
    'handheld_smart_create', v_sku.id, v_sku.epc, p_note);

  IF v_op_id IS NOT NULL THEN
    UPDATE public.handheld_smart_create_ops
      SET sku_id = v_sku.id, bound_epcs = v_bound, stock_qty = v_qty
      WHERE id = v_op_id;
  END IF;

  IF p_release_shop_id IS NOT NULL THEN
    INSERT INTO public.handheld_youzan_release_outbox (sku_id, shop_id, location_id, source_op_id)
    VALUES (v_sku.id, p_release_shop_id, p_location_id, v_op_id)
    ON CONFLICT (sku_id, shop_id) DO UPDATE
      SET status = CASE WHEN handheld_youzan_release_outbox.status = 'processing'
                        THEN 'processing' ELSE 'pending' END,
          next_attempt_at = now(), location_id = EXCLUDED.location_id,
          attempts = CASE WHEN handheld_youzan_release_outbox.status = 'processing'
                          THEN handheld_youzan_release_outbox.attempts ELSE 0 END,
          last_error = NULL, updated_at = now();
  END IF;

  RETURN jsonb_build_object(
    'op_id', v_op_id, 'replayed', false, 'op_status', 'committed',
    'sku_id', v_sku.id, 'sku_code', v_sku.sku_code, 'epc', v_sku.epc,
    'bound_epcs', v_bound, 'stock_qty', v_qty, 'response', NULL);
END;
$function$
