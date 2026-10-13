\set ON_ERROR_STOP 1
-- U=员工 D=本设备；A/B 两店
\set U '''5a000000-0000-4000-8000-000000000001'''
INSERT INTO inv_handheld_notifications(kind,location_id,user_id,device_id) VALUES
 ('order_paid','5c000000-0000-4000-8000-00000000000a',NULL,NULL),
 ('order_paid','5c000000-0000-4000-8000-00000000000a',NULL,NULL),
 ('order_paid','5c000000-0000-4000-8000-00000000000b',NULL,NULL),
 ('transfer_incoming','5c000000-0000-4000-8000-00000000000a',NULL,NULL),
 ('stocktake_assigned',NULL,'5a000000-0000-4000-8000-000000000001',NULL),
 ('youzan_sync_failed','5c000000-0000-4000-8000-00000000000a',NULL,NULL),
 ('system',NULL,NULL,NULL),
 ('order_paid','5c000000-0000-4000-8000-00000000000a','5a000000-0000-4000-8000-0000000000ff',NULL),
 ('system','5c000000-0000-4000-8000-00000000000a',NULL,'5d000000-0000-4000-8000-0000000000ff'),
 ('support_message','5c000000-0000-4000-8000-00000000000a',NULL,NULL);
-- 大量订单提醒：验证全量计数（>500）
INSERT INTO inv_handheld_notifications(kind,location_id) SELECT 'order_paid','5c000000-0000-4000-8000-00000000000a' FROM generate_series(1,600);
INSERT INTO support_conversations(id,location_id) VALUES ('5f000000-0000-4000-8000-000000000001','5c000000-0000-4000-8000-00000000000a'),
 ('5f000000-0000-4000-8000-000000000002','5c000000-0000-4000-8000-00000000000a'),('5f000000-0000-4000-8000-000000000003','5c000000-0000-4000-8000-00000000000b');
INSERT INTO support_participants(conversation_id,user_id,last_read_at) VALUES ('5f000000-0000-4000-8000-000000000001','5a000000-0000-4000-8000-000000000001',now()-interval '1 hour');
INSERT INTO support_messages(conversation_id,sender_type,created_at) VALUES
 ('5f000000-0000-4000-8000-000000000001','customer',now()-interval '2 hour'),
 ('5f000000-0000-4000-8000-000000000001','customer',now()),
 ('5f000000-0000-4000-8000-000000000001','staff',now()),
 ('5f000000-0000-4000-8000-000000000002','customer',now()),
 ('5f000000-0000-4000-8000-000000000002','customer',now()),
 ('5f000000-0000-4000-8000-000000000003','customer',now());
DO $$ DECLARE r jsonb; BEGIN
  r := handheld_unread_counts('5a000000-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001',ARRAY['5c000000-0000-4000-8000-00000000000a']::uuid[],false);
  ASSERT r = '{"customers":3,"internal":2,"orders":602,"system":2,"total":609}'::jsonb, 'UC1 store A: '||r::text;
  RAISE NOTICE 'PASS UC1 store A counts (full count >500, no other-store/other-user/device, customer notice not double counted)';
  -- 单条已读只减对应类别
  INSERT INTO handheld_notification_reads(notification_id,user_id,read_at)
    SELECT id,'5a000000-0000-4000-8000-000000000001',now() FROM inv_handheld_notifications WHERE kind='transfer_incoming';
  UPDATE support_participants SET last_read_at=now()+interval '1 second' WHERE conversation_id='5f000000-0000-4000-8000-000000000001';
  r := handheld_unread_counts('5a000000-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001',ARRAY['5c000000-0000-4000-8000-00000000000a']::uuid[],false);
  ASSERT r = '{"customers":2,"internal":1,"orders":602,"system":2,"total":607}'::jsonb, 'UC2 after reads: '||r::text;
  RAISE NOTICE 'PASS UC2 single read and conversation mark-read decrement only their category';
  r := handheld_unread_counts('5a000000-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001',ARRAY['5c000000-0000-4000-8000-00000000000b']::uuid[],false);
  ASSERT r = '{"customers":1,"internal":1,"orders":1,"system":1,"total":4}'::jsonb, 'UC3 store B: '||r::text;
  RAISE NOTICE 'PASS UC3 store B isolated';
  ASSERT NOT has_function_privilege('authenticated','handheld_unread_counts(uuid,uuid,uuid[],boolean)','EXECUTE')
     AND NOT has_function_privilege('anon','handheld_unread_counts(uuid,uuid,uuid[],boolean)','EXECUTE'), 'UC4 grants';
  RAISE NOTICE 'PASS UC4 service_role only';
END $$;
-- UC5 分类合约：lowercase + . - → _，前缀匹配
INSERT INTO inv_handheld_notifications(kind,location_id) SELECT k,'5c000000-0000-4000-8000-00000000000c' FROM unnest(ARRAY[
 'refund_succeeded','Fulfillment.Picked','pickup-ready','shipment_created','shortage','ORDER','orders_x',
 'customer_message','Conversation.New','inquiry','support-escalated',
 'announcement','Internal.Note','transfer_incoming','stocktake-assigned',
 'unclaimed_epc_pending','youzan_sync_failed','system','refundish']) k;
DO $$ DECLARE r jsonb; BEGIN
  r := handheld_unread_counts('5a000000-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001',ARRAY['5c000000-0000-4000-8000-00000000000c']::uuid[],false);
  -- orders 6 (orders_x/refundish 非前缀→system)；customers 类通知不计；internal 4；system 5 + 全局 system 1 = 6；另个人 stocktake_assigned 1 → internal 5
  ASSERT r = '{"customers":0,"internal":5,"orders":6,"system":6,"total":17}'::jsonb, 'UC5 classification: '||r::text;
  RAISE NOTICE 'PASS UC5 normalized prefix classification';
END $$;
