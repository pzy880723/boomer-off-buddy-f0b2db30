\set ON_ERROR_STOP 1
-- 真实状态链证据：现行函数产出的实际值
DO $$ DECLARE r record; BEGIN
  SELECT o.payment_status ps, o.order_status os, s.status ss, s.refund_state rs, i.state ist, rf.status rfs, a.status ast
    INTO r FROM commerce_orders o JOIN fulfillment_shortages s ON s.order_id=o.id JOIN commerce_refund_intents i ON i.id=s.refund_intent_id
    JOIN commerce_refunds rf ON rf.id=i.refund_id JOIN commerce_after_sales a ON a.id=i.after_sale_id WHERE o.id=t_id('o1');
  RAISE NOTICE 'CHAIN o1: order=%/% shortage=%/% intent=% refund=% after_sale=%', r.ps, r.os, r.ss, r.rs, r.ist, r.rfs, r.ast;
  ASSERT r.ps='partially_refunded' AND r.rs='succeeded' AND r.ist='succeeded' AND r.rfs='succeeded', 'real chain values';
  SELECT payment_status ps, order_status os INTO r FROM commerce_orders WHERE id=t_id('o7');
  ASSERT r.ps='refunded' AND r.os='closed', format('full refund chain %s/%s', r.ps, r.os);
  SELECT payment_status ps INTO r FROM commerce_orders WHERE id=t_id('o8'); ASSERT r.ps='partially_refunded', 'non-shortage partial';
  RAISE NOTICE 'PASS real state chain: partially_refunded + refund_state=succeeded (not refund_completed)';
END $$;
