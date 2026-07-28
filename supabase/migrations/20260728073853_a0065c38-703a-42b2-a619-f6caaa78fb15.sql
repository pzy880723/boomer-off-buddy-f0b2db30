CREATE OR REPLACE FUNCTION public.pos_record_cash_adjustment(
  p_shift_id uuid,
  p_operator_id uuid,
  p_type text,
  p_amount numeric,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shift public.pos_shifts;
  v_balance numeric(12,2);
  v_signed_amount numeric(12,2);
  v_movement public.pos_cash_movements;
BEGIN
  IF p_type NOT IN ('cash_in', 'cash_out') THEN
    RAISE EXCEPTION 'unsupported_cash_movement';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'invalid_cash_amount';
  END IF;
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'cash_reason_required';
  END IF;

  SELECT *
    INTO v_shift
    FROM public.pos_shifts
   WHERE id = p_shift_id
   FOR UPDATE;

  IF NOT FOUND OR v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift_not_open';
  END IF;
  IF v_shift.operator_id <> p_operator_id THEN
    RAISE EXCEPTION 'shift_operator_mismatch';
  END IF;

  SELECT v_shift.opening_cash + COALESCE(SUM(amount), 0)
    INTO v_balance
    FROM public.pos_cash_movements
   WHERE shift_id = p_shift_id;

  IF p_type = 'cash_out' AND p_amount > v_balance THEN
    RAISE EXCEPTION 'insufficient_drawer_balance';
  END IF;

  v_signed_amount := CASE WHEN p_type = 'cash_out' THEN -p_amount ELSE p_amount END;

  INSERT INTO public.pos_cash_movements (
    shift_id,
    type,
    amount,
    reason,
    operator_id
  )
  VALUES (
    p_shift_id,
    p_type,
    v_signed_amount,
    btrim(p_reason),
    p_operator_id
  )
  RETURNING * INTO v_movement;

  RETURN jsonb_build_object(
    'movement_id', v_movement.id,
    'type', p_type,
    'amount', p_amount,
    'balance', v_balance + v_signed_amount,
    'created_at', v_movement.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pos_record_cash_adjustment(
  uuid,
  uuid,
  text,
  numeric,
  text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_record_cash_adjustment(
  uuid,
  uuid,
  text,
  numeric,
  text
) TO service_role;