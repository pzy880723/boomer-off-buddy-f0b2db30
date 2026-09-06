-- 扫码幂等加固：原实现按 (device_id, client_op_id) 判重，device_id 为 NULL 时会漏判导致重复计数。
CREATE UNIQUE INDEX IF NOT EXISTS uq_fulfillment_scans_client_op
  ON public.fulfillment_scans(fulfillment_id, client_op_id)
  WHERE client_op_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fulfillment_pick_scan(
  p_fulfillment_id uuid,
  p_location_id uuid,
  p_code text,
  p_device_id uuid,
  p_operator_id uuid,
  p_client_op_id text,
  p_fulfillment_item_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fulfillment public.fulfillments;
  v_item public.fulfillment_items;
  v_prev public.fulfillment_scans;
  v_total integer;
  v_picked integer;
BEGIN
  IF p_client_op_id IS NOT NULL THEN
    SELECT * INTO v_prev FROM public.fulfillment_scans
     WHERE fulfillment_id = p_fulfillment_id AND client_op_id = p_client_op_id
     LIMIT 1;
    IF FOUND THEN
      SELECT count(*), count(*) FILTER (WHERE picked_qty >= expected_qty)
        INTO v_total, v_picked
        FROM public.fulfillment_items WHERE fulfillment_id = p_fulfillment_id;
      RETURN jsonb_build_object(
        'accepted', v_prev.result = 'accepted',
        'replayed', true,
        'reason', v_prev.rejection_reason,
        'fulfillment_item_id', v_prev.fulfillment_item_id,
        'picked', v_picked, 'total', v_total);
    END IF;
  END IF;

  SELECT * INTO v_fulfillment FROM public.fulfillments
   WHERE id = p_fulfillment_id AND location_id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment not found at this location'; END IF;
  IF v_fulfillment.status NOT IN ('allocated','picking') THEN RAISE EXCEPTION 'fulfillment is not pickable'; END IF;

  SELECT fi.* INTO v_item
    FROM public.fulfillment_items fi
    JOIN public.inv_skus sku ON sku.id = fi.sku_id
   WHERE fi.fulfillment_id = p_fulfillment_id
     AND (p_fulfillment_item_id IS NULL OR fi.id = p_fulfillment_item_id)
     AND (fi.epc = p_code OR sku.epc = p_code OR sku.barcode = p_code OR sku.sku_code = p_code)
     AND fi.picked_qty < fi.expected_qty
   ORDER BY fi.picked_qty ASC
   LIMIT 1 FOR UPDATE OF fi;

  IF NOT FOUND THEN
    INSERT INTO public.fulfillment_scans(
      fulfillment_id, phase, code, code_type, result, rejection_reason, device_id, operator_id, client_op_id
    ) VALUES (
      p_fulfillment_id, 'pick', p_code, 'barcode', 'rejected',
      CASE WHEN p_fulfillment_item_id IS NULL THEN 'wrong_item' ELSE 'line_mismatch' END,
      p_device_id, p_operator_id, p_client_op_id
    );
    SELECT count(*), count(*) FILTER (WHERE picked_qty >= expected_qty)
      INTO v_total, v_picked
      FROM public.fulfillment_items WHERE fulfillment_id = p_fulfillment_id;
    RETURN jsonb_build_object(
      'accepted', false,
      'reason', CASE WHEN p_fulfillment_item_id IS NULL THEN 'wrong_item' ELSE 'line_mismatch' END,
      'picked', v_picked, 'total', v_total);
  END IF;

  UPDATE public.fulfillment_items
     SET picked_qty = least(picked_qty + 1, expected_qty),
         picked_at = coalesce(picked_at, now())
   WHERE id = v_item.id;

  INSERT INTO public.fulfillment_scans(
    fulfillment_id, fulfillment_item_id, phase, code, code_type, result, device_id, operator_id, client_op_id
  ) VALUES (
    p_fulfillment_id, v_item.id, 'pick', p_code, 'barcode', 'accepted', p_device_id, p_operator_id, p_client_op_id
  );

  UPDATE public.fulfillments
     SET status = 'picking',
         picking_started_at = coalesce(picking_started_at, now()),
         claimed_device_id = coalesce(claimed_device_id, p_device_id),
         updated_at = now()
   WHERE id = p_fulfillment_id;

  SELECT count(*), count(*) FILTER (WHERE picked_qty >= expected_qty)
    INTO v_total, v_picked
    FROM public.fulfillment_items WHERE fulfillment_id = p_fulfillment_id;
  RETURN jsonb_build_object('accepted', true, 'replayed', false,
    'fulfillment_item_id', v_item.id, 'picked', v_picked, 'total', v_total);
END; $$;

REVOKE ALL ON FUNCTION public.fulfillment_pick_scan(uuid,uuid,text,uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fulfillment_pick_scan(uuid,uuid,text,uuid,uuid,text,uuid) TO service_role;