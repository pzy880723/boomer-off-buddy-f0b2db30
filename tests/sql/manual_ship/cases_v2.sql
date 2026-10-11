\set ON_ERROR_STOP 1
SET ROLE service_role;
DO $$ DECLARE r jsonb; n int; s text; hq uuid:='00000000-0000-0000-0000-0000000001e2'; BEGIN
  -- 完整性：g3 两行只报一行 → lines_incomplete，无写入
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f3','sf','SFT301','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000131","quantity":1}]','v2-incomplete');
  ASSERT r->>'result'='lines_incomplete', 'incomplete '||r::text;
  SELECT sum(picked_qty) INTO n FROM fulfillment_items WHERE fulfillment_id='00000000-0000-0000-0000-0000000001f3'; ASSERT n=0, 'no partial pick';
  SELECT status INTO s FROM fulfillments WHERE id='00000000-0000-0000-0000-0000000001f3'; ASSERT s='picking', 'status unchanged';
  -- 重复行 → invalid_lines
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f3','sf','SFT301','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000131","quantity":1},{"fulfillment_item_id":"00000000-0000-0000-0000-000000000131","quantity":1},{"fulfillment_item_id":"00000000-0000-0000-0000-000000000132","quantity":1}]','v2-dupline');
  ASSERT r->>'result'='invalid_lines', 'dup line '||r::text;
  -- 乱序完整 + manual 承运商（中通）→ 成功；picked 补到应发量
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f3','manual','ZT301','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000132","quantity":1},{"fulfillment_item_id":"00000000-0000-0000-0000-000000000131","quantity":1}]','v2-manual-zt','中通快递');
  ASSERT r->>'result'='shipped' AND r->>'provider'='manual' AND r->>'carrier_label'='中通快递', 'manual '||r::text;
  SELECT provider||'|'||carrier_label INTO s FROM shipments WHERE fulfillment_id='00000000-0000-0000-0000-0000000001f3'; ASSERT s='manual|中通快递', 'stored label not mapped to cainiao: '||s;
  SELECT sum(picked_qty) INTO n FROM fulfillment_items WHERE fulfillment_id='00000000-0000-0000-0000-0000000001f3'; ASSERT n=2, 'picked filled to shippable';
  -- 乱序同内容重放 → replayed；改承运商名 → 冲突
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f3','manual','ZT301','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000131","quantity":1},{"fulfillment_item_id":"00000000-0000-0000-0000-000000000132","quantity":1}]','v2-manual-zt',' 中通快递 ');
  ASSERT (r->>'replayed')::bool, 'reorder replay '||r::text;
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f3','manual','ZT301','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000131","quantity":1},{"fulfillment_item_id":"00000000-0000-0000-0000-000000000132","quantity":1}]','v2-manual-zt','圆通');
  ASSERT r->>'result'='idempotency_conflict', 'label change conflict '||r::text;
  SELECT sum(picked_qty) INTO n FROM fulfillment_items WHERE fulfillment_id='00000000-0000-0000-0000-0000000001f3'; ASSERT n=2, 'replay no double';
  -- manual 无承运商名 → invalid_carrier_label；sf 名称不能伪装
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f2','manual','ZT201','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000121","quantity":2}]','v2-nolabel',NULL);
  ASSERT r->>'result'='invalid_carrier_label', 'no label '||r::text;
  -- 未拣（allocated）直接整单发货：qty 必须等于应发量
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f2','sf','SFT201','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000121","quantity":1}]','v2-short');
  ASSERT r->>'result'='lines_incomplete', 'under qty '||r::text;
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f2','sf','SFT201','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000121","quantity":3}]','v2-over');
  ASSERT r->>'result'='qty_exceeded', 'over qty '||r::text;
  -- 缺货待客户确认 / 退款中 → 禁止
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f4','sf','SFT401','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000141","quantity":1}]','v2-pending');
  ASSERT r->>'result'='shortage_blocked', 'pending '||r::text;
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f6','sf','SFT601','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000161","quantity":1}]','v2-refunding');
  ASSERT r->>'result'='shortage_blocked', 'refunding '||r::text;
  -- 缺货已同意且退款完成 → 应发量=2-1=1；发 1 成功，发 2 超量
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f5','sf','SFT501','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000151","quantity":2}]','v2-short-over');
  ASSERT r->>'result'='qty_exceeded', 'approved shortage over '||r::text;
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f5','sf','SFT501','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000151","quantity":1}]','v2-short-ok');
  ASSERT r->>'result'='shipped', 'approved shortage ship '||r::text;
  SELECT picked_qty INTO n FROM fulfillment_items WHERE id='00000000-0000-0000-0000-000000000151'; ASSERT n=1, 'picked stays 1';
  -- 真实业务：g1 两行已拣满后登记（乱序）
  r := commerce_manual_ship_fulfillment(hq,NULL,'00000000-0000-0000-0000-0000000001f1','cainiao','CNT101','[{"fulfillment_item_id":"00000000-0000-0000-0000-000000000112","quantity":1},{"fulfillment_item_id":"00000000-0000-0000-0000-000000000111","quantity":1}]','v2-picked-two');
  ASSERT r->>'result'='shipped', 'two-line picked '||r::text;
  SELECT sum(picked_qty) INTO n FROM fulfillment_items WHERE fulfillment_id='00000000-0000-0000-0000-0000000001f1'; ASSERT n=2, 'g1 picked unchanged';
  RAISE NOTICE 'PASS v2 integrity/shortage/manual/replay';
END $$;
