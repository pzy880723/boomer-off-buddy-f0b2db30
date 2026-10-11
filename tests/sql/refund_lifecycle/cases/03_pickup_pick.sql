\set ON_ERROR_STOP 0
DO $$ DECLARE r jsonb; n int; BEGIN
  r := commerce_pickup_mark_ready('aaaaaaaa-0000-4000-8000-0000000000f2','aaaaaaaa-0000-4000-8000-00000000000a',t_id('f9'),'ready-s9-0001');
  ASSERT r->>'result'='ready', 'S9 pickup mark_ready after cleared shortage: '||r::text;
  SELECT picked_qty INTO n FROM fulfillment_items WHERE id=t_id('i92'); ASSERT n=0, 'S9 cleared line not marked picked';
  RAISE NOTICE 'PASS S9 pickup ready with cleared shortage';
END $$;
DO $$ DECLARE r jsonb; BEGIN
  r := commerce_pickup_redeem('aaaaaaaa-0000-4000-8000-0000000000f2','aaaaaaaa-0000-4000-8000-00000000000a',NULL,'4821','redeem-s9-001');
  ASSERT r->>'result'='redeemed', 'S9 pickup redeem: '||r::text; RAISE NOTICE 'PASS S9 pickup redeem with cleared shortage'; END $$;
DO $$ DECLARE r jsonb; BEGIN
  r := commerce_pickup_mark_ready('aaaaaaaa-0000-4000-8000-0000000000f2','aaaaaaaa-0000-4000-8000-00000000000a',t_id('f10'),'ready-s10-001');
  ASSERT r->>'ok'='false', 'S10 refund processing must block pickup: '||r::text; RAISE NOTICE 'PASS S10 pickup blocked while refund processing'; END $$;
DO $$ DECLARE r fulfillments; BEGIN
  r := fulfillment_complete_pick(t_id('f11'),'aaaaaaaa-0000-4000-8000-00000000000a',NULL);
  ASSERT r.status='picked', 'S11'; RAISE NOTICE 'PASS S11 complete_pick with cleared shortage';
EXCEPTION WHEN raise_exception THEN RAISE EXCEPTION 'S11 complete_pick rejected: %', SQLERRM; END $$;
UPDATE fulfillments SET status='picking' WHERE id=t_id('f12');
UPDATE fulfillment_items SET picked_qty=1 WHERE id=t_id('i121');
DO $$ BEGIN
  PERFORM fulfillment_complete_pick(t_id('f12'),'aaaaaaaa-0000-4000-8000-00000000000a',NULL);
  RAISE EXCEPTION 'S12 complete_pick accepted forged refund_completed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'S12%' THEN RAISE; END IF; ASSERT SQLERRM LIKE '%refund_pending%' OR SQLERRM LIKE '%unpicked%', 'S12 wrong reason: '||SQLERRM; RAISE NOTICE 'PASS S12 complete_pick rejects forged string';
END $$;
