\set ON_ERROR_STOP 0
DO $$ DECLARE r text; n int; BEGIN
  r := t_ship('f1', jsonb_build_array(t_line('i11',1)), 'k-s1')->>'result';
  ASSERT r='shipped', 'S1 one shortage cleared, other ships: '||r; RAISE NOTICE 'PASS S1 cleared shortage + remaining item ships';
END $$;
DO $$ DECLARE n int; BEGIN SELECT picked_qty INTO n FROM fulfillment_items WHERE id=t_id('i12'); ASSERT n=0, 'shortage line not picked up';
  RAISE NOTICE 'PASS S1 shortage line picked_qty stays 0'; END $$;
DO $$ DECLARE r text; BEGIN
  r := t_ship('f2b', jsonb_build_array(t_line('i2b',1)), 'k-s2b')->>'result'; ASSERT r='shipped', 'S2 other store ships: '||r;
  RAISE NOTICE 'PASS S2 cross-store other store ships'; END $$;
DO $$ DECLARE r text; BEGIN
  r := t_ship('f2a', jsonb_build_array(t_line('i2a',1)), 'k-s2a')->>'result'; ASSERT r IN ('qty_exceeded','nothing_to_ship'), 'S2 fully-short store not shippable: '||r;
  RAISE NOTICE 'PASS S2 fully-short store not shippable'; END $$;
DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['3','4','5','6'] LOOP
    r := t_ship('f'||t, jsonb_build_array(t_line('i'||t||'1',1)), 'k-pending-'||t)->>'result';
    ASSERT r IN ('refund_blocked','shortage_blocked'), format('S%s unsettled refund must block, got %s', t, r);
  END LOOP; RAISE NOTICE 'PASS S3-6 queued/processing/failed/manual_review block shipping'; END $$;
DO $$ DECLARE r text; BEGIN r := t_ship('f7', jsonb_build_array(t_line('i71',1)), 'k-s7')->>'result';
  ASSERT r IN ('refund_blocked','cancelled'), 'S7 full refund: '||r; RAISE NOTICE 'PASS S7 full refund blocks'; END $$;
DO $$ DECLARE r text; BEGIN r := t_ship('f8', jsonb_build_array(t_line('i81',1)), 'k-s8')->>'result';
  ASSERT r='refund_blocked', 'S8 non-shortage partial refund: '||r; RAISE NOTICE 'PASS S8 non-shortage partial refund blocks'; END $$;
DO $$ DECLARE r text; BEGIN
  r := t_ship('f12', jsonb_build_array(t_line('i121',1)), 'k-s12')->>'result'; ASSERT r IN ('refund_blocked','shortage_blocked'), 'S12 forged refund_completed: '||r;
  r := t_ship('f13', jsonb_build_array(t_line('i131',1)), 'k-s13')->>'result'; ASSERT r IN ('refund_blocked','shortage_blocked'), 'S13 forged succeeded: '||r;
  RAISE NOTICE 'PASS S12/13 refund_state string without evidence blocks'; END $$;
DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM shipments WHERE fulfillment_id IN (t_id('f3'),t_id('f4'),t_id('f5'),t_id('f6'),t_id('f7'),t_id('f8'),t_id('f12'),t_id('f13'));
  ASSERT n=0, 'blocked writes nothing'; RAISE NOTICE 'PASS blocked requests leave no shipment'; END $$;
