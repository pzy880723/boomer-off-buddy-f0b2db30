-- 全额退款成功 → 订单原子关闭；部分/失败/重复不误关；多次部分合计全退关闭；已交接历史不被覆盖；已全退禁止继续拣货/出库。
CREATE TABLE IF NOT EXISTS public.commerce_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid, provider text NOT NULL,
  provider_event_id text, event_type text NOT NULL, signature_verified boolean, payload jsonb,
  processing_status text DEFAULT 'pending', error text, received_at timestamptz DEFAULT now(), processed_at timestamptz,
  UNIQUE (provider, provider_event_id));

CREATE OR REPLACE FUNCTION pg_temp.mk(p_tag text, p_paid numeric) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c jsonb := public.t_mk_order(p_tag, 1, p_paid, 0, p_paid);
BEGIN
  UPDATE public.commerce_orders SET order_status = 'processing' WHERE id = (c->>'order_id')::uuid;
  UPDATE public.commerce_payments SET provider_transaction_id = 'tx-' || p_tag WHERE id = (c->>'payment_id')::uuid;
  RETURN c;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.refund(c jsonb, p_no text, p_amt numeric, p_status text, p_event text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_paid numeric; v_tx text;
BEGIN
  SELECT amount, provider_transaction_id INTO v_paid, v_tx FROM public.commerce_payments WHERE id = (c->>'payment_id')::uuid;
  INSERT INTO public.commerce_refunds(order_id, payment_id, provider, status, amount, idempotency_key, merchant_refund_no, route_snapshot)
    VALUES ((c->>'order_id')::uuid, (c->>'payment_id')::uuid, 'wechat', 'processing', p_amt, 'idem-' || p_no, p_no,
            '{"merchant_id":"m1"}') ON CONFLICT DO NOTHING;
  RETURN public.commerce_apply_ordinary_refund(jsonb_build_object(
    'event_id', coalesce(p_event, 'ev-' || p_no || '-' || p_status), 'status', p_status,
    'merchant_refund_no', p_no, 'provider_refund_id', 'pr-' || p_no, 'merchant_id', 'm1',
    'transaction_id', v_tx, 'total_fen', v_paid * 100, 'refund_fen', p_amt * 100, 'refunded_at', now()));
END $$;

CREATE OR REPLACE FUNCTION pg_temp.st(c jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT order_status || '/' || payment_status FROM public.commerce_orders WHERE id = (c->>'order_id')::uuid $$;

DO $$
DECLARE a jsonb; b jsonb; f jsonb; d jsonb; m jsonb; h jsonb; x jsonb; mp jsonb;
  p2 uuid; n int; blocked boolean;
BEGIN
  -- 1) 全退
  a := pg_temp.mk('r_full', 100);
  PERFORM pg_temp.refund(a, 'A1', 100, 'succeeded');
  IF pg_temp.st(a) <> 'closed/refunded' THEN RAISE EXCEPTION 'FAIL full: %', pg_temp.st(a); END IF;
  SELECT count(*) INTO n FROM public.commerce_order_status_audit WHERE order_id = (a->>'order_id')::uuid AND from_status = 'processing';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL full audit %', n; END IF;
  -- 4) 重复回调幂等
  PERFORM pg_temp.refund(a, 'A1', 100, 'succeeded');
  SELECT count(*) INTO n FROM public.commerce_order_status_audit WHERE order_id = (a->>'order_id')::uuid;
  IF n <> 1 OR pg_temp.st(a) <> 'closed/refunded' THEN RAISE EXCEPTION 'FAIL replay audit=%', n; END IF;

  -- 2) 部分退款不关
  b := pg_temp.mk('r_part', 100);
  PERFORM pg_temp.refund(b, 'B1', 40, 'succeeded');
  IF pg_temp.st(b) <> 'processing/partially_refunded' THEN RAISE EXCEPTION 'FAIL partial: %', pg_temp.st(b); END IF;
  -- 5) 多次部分合计全退 → 关闭
  PERFORM pg_temp.refund(b, 'B2', 60, 'succeeded');
  IF pg_temp.st(b) <> 'closed/refunded' THEN RAISE EXCEPTION 'FAIL multi-partial: %', pg_temp.st(b); END IF;

  -- 3) 失败不关
  f := pg_temp.mk('r_fail', 100);
  PERFORM pg_temp.refund(f, 'F1', 100, 'failed');
  IF pg_temp.st(f) <> 'processing/paid' THEN RAISE EXCEPTION 'FAIL failed: %', pg_temp.st(f); END IF;
  -- 处理中（未回调）不关
  INSERT INTO public.commerce_refunds(order_id, payment_id, provider, status, amount, idempotency_key, merchant_refund_no, route_snapshot)
    VALUES ((f->>'order_id')::uuid, (f->>'payment_id')::uuid, 'wechat', 'processing', 100, 'idem-F2', 'F2', '{"merchant_id":"m1"}');
  IF pg_temp.st(f) <> 'processing/paid' THEN RAISE EXCEPTION 'FAIL processing'; END IF;

  -- 6) 已交接历史：关单但不改履约/发货记录
  h := pg_temp.mk('r_ship', 100);
  UPDATE public.fulfillments SET status = 'handed_over' WHERE order_id = (h->>'order_id')::uuid;
  INSERT INTO public.shipments(fulfillment_id, provider, service_code, status, idempotency_key)
    SELECT id, 'sf', 'SF_STD', 'in_transit', 'ship-h' FROM public.fulfillments WHERE order_id = (h->>'order_id')::uuid;
  PERFORM pg_temp.refund(h, 'H1', 100, 'succeeded');
  IF pg_temp.st(h) <> 'closed/refunded' THEN RAISE EXCEPTION 'FAIL shipped close'; END IF;
  SELECT count(*) INTO n FROM public.fulfillments f JOIN public.shipments s ON s.fulfillment_id = f.id
   WHERE f.order_id = (h->>'order_id')::uuid AND f.status = 'handed_over' AND s.status = 'in_transit';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL shipped history altered'; END IF;

  -- 7) 已全退：未交接履约不得继续拣货/出库；允许转 exception
  blocked := false;
  BEGIN UPDATE public.fulfillments SET status = 'picked' WHERE order_id = (a->>'order_id')::uuid;
  EXCEPTION WHEN others THEN blocked := SQLERRM LIKE '%order_refunded%'; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL pick not blocked'; END IF;
  blocked := false;
  BEGIN UPDATE public.fulfillment_items SET picked_qty = 1
         WHERE fulfillment_id IN (SELECT id FROM public.fulfillments WHERE order_id = (a->>'order_id')::uuid);
  EXCEPTION WHEN others THEN blocked := SQLERRM LIKE '%order_refunded%'; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL scan not blocked'; END IF;
  blocked := false;
  BEGIN INSERT INTO public.shipments(fulfillment_id, provider, service_code, idempotency_key)
         SELECT id, 'sf', 'SF_STD', 'ship-a' FROM public.fulfillments WHERE order_id = (a->>'order_id')::uuid;
  EXCEPTION WHEN others THEN blocked := SQLERRM LIKE '%order_refunded%'; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL shipment not blocked'; END IF;
  UPDATE public.fulfillments SET status = 'exception' WHERE order_id = (a->>'order_id')::uuid;
  -- 部分退款订单仍可拣货
  UPDATE public.fulfillment_items SET picked_qty = 1
   WHERE fulfillment_id IN (SELECT id FROM public.fulfillments WHERE order_id = (f->>'order_id')::uuid);

  -- 8) 回填：只关账本相符的历史单
  d := pg_temp.mk('r_hist_ok', 100);
  INSERT INTO public.commerce_refunds(order_id, payment_id, provider, status, amount, idempotency_key, merchant_refund_no)
    VALUES ((d->>'order_id')::uuid, (d->>'payment_id')::uuid, 'wechat', 'succeeded', 100, 'idem-D1', 'D1');
  UPDATE public.commerce_payments SET status = 'refunded' WHERE id = (d->>'payment_id')::uuid;
  UPDATE public.commerce_orders SET payment_status = 'refunded' WHERE id = (d->>'order_id')::uuid;
  m := pg_temp.mk('r_hist_bad', 100);  -- 状态说全退但账本只有 50
  INSERT INTO public.commerce_refunds(order_id, payment_id, provider, status, amount, idempotency_key, merchant_refund_no)
    VALUES ((m->>'order_id')::uuid, (m->>'payment_id')::uuid, 'wechat', 'succeeded', 50, 'idem-M1', 'M1');
  UPDATE public.commerce_payments SET status = 'refunded' WHERE id = (m->>'payment_id')::uuid;
  UPDATE public.commerce_orders SET payment_status = 'refunded' WHERE id = (m->>'order_id')::uuid;
  PERFORM public.commerce_close_order_if_fully_refunded(o.id, 'backfill_full_refund_ledger_verified', '{"backfill":true}')
    FROM public.commerce_orders o WHERE o.payment_status = 'refunded' AND o.order_status NOT IN ('closed','cancelled');
  IF pg_temp.st(d) <> 'closed/refunded' THEN RAISE EXCEPTION 'FAIL backfill ok'; END IF;
  IF pg_temp.st(m) <> 'processing/refunded' THEN RAISE EXCEPTION 'FAIL backfill mismatched closed'; END IF;

  -- 9) 付款账本只有订单金额一半，即使单笔付款/退款互相匹配也不得关单
  x := pg_temp.mk('r_paid_short', 50);
  UPDATE public.commerce_orders SET total_amount = 100, payment_status = 'refunded'
   WHERE id = (x->>'order_id')::uuid;
  INSERT INTO public.commerce_refunds(order_id, payment_id, provider, status, amount, idempotency_key, merchant_refund_no)
    VALUES ((x->>'order_id')::uuid, (x->>'payment_id')::uuid, 'wechat', 'succeeded', 50, 'idem-X1', 'X1');
  UPDATE public.commerce_payments SET status = 'refunded' WHERE id = (x->>'payment_id')::uuid;
  PERFORM public.commerce_close_order_if_fully_refunded((x->>'order_id')::uuid, 'test_paid_total_mismatch', '{}');
  IF pg_temp.st(x) <> 'processing/refunded' THEN RAISE EXCEPTION 'FAIL paid total mismatch closed: %', pg_temp.st(x); END IF;

  -- 10) 两笔有效付款分别全退，订单汇总状态必须最终变为 refunded 并关单
  mp := pg_temp.mk('r_multi_payment', 40);
  UPDATE public.commerce_orders SET total_amount = 100 WHERE id = (mp->>'order_id')::uuid;
  p2 := gen_random_uuid();
  INSERT INTO public.commerce_payments(id, order_id, provider, amount, status, idempotency_key,
                                       provider_transaction_id, paid_at)
    VALUES (p2, (mp->>'order_id')::uuid, 'wechat', 60, 'succeeded', 'pay-r_multi_payment-2',
            'tx-r_multi_payment-2', now());
  PERFORM pg_temp.refund(mp, 'MP1', 40, 'succeeded');
  IF pg_temp.st(mp) <> 'processing/partially_refunded' THEN RAISE EXCEPTION 'FAIL multi payment first: %', pg_temp.st(mp); END IF;
  PERFORM pg_temp.refund(mp || jsonb_build_object('payment_id', p2), 'MP2', 60, 'succeeded');
  IF pg_temp.st(mp) <> 'closed/refunded' THEN RAISE EXCEPTION 'FAIL multi payment full: %', pg_temp.st(mp); END IF;

  -- 11) exception 不得成为全退后的恢复通道；handed_over/exception 父状态也不得放行子表新增出库
  blocked := false;
  BEGIN UPDATE public.fulfillments SET status = 'picking' WHERE order_id = (a->>'order_id')::uuid;
  EXCEPTION WHEN others THEN blocked := SQLERRM LIKE '%order_refunded%'; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL exception to picking not blocked'; END IF;
  blocked := false;
  BEGIN UPDATE public.fulfillments SET status = 'handed_over' WHERE order_id = (a->>'order_id')::uuid;
  EXCEPTION WHEN others THEN blocked := SQLERRM LIKE '%order_refunded%'; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL exception to handed_over not blocked'; END IF;
  blocked := false;
  BEGIN UPDATE public.fulfillment_items SET picked_qty = 1
         WHERE fulfillment_id IN (SELECT id FROM public.fulfillments WHERE order_id = (h->>'order_id')::uuid);
  EXCEPTION WHEN others THEN blocked := SQLERRM LIKE '%order_refunded%'; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL handed_over child pick not blocked'; END IF;

  RAISE NOTICE 'PASS 06_full_refund_closes_order';
END $$;
SELECT 'PASS 06_full_refund_closes_order';
