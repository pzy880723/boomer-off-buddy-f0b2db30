-- 手持通知可见范围（增量变更 RPC）：定向他人/他设备的同店通知不得泄漏；显式门店只看本店。
\set ON_ERROR_STOP 1
INSERT INTO inv_locations(id) VALUES ('5c000000-0000-4000-8000-00000000000a'),('5c000000-0000-4000-8000-00000000000b') ON CONFLICT DO NOTHING;
INSERT INTO inv_handheld_notifications(id,kind,location_id,user_id,device_id,title) VALUES
 ('5e000000-0000-4000-8000-000000000001','system','5c000000-0000-4000-8000-00000000000a',NULL,NULL,'A store'),
 ('5e000000-0000-4000-8000-000000000002','system','5c000000-0000-4000-8000-00000000000b',NULL,NULL,'B store'),
 ('5e000000-0000-4000-8000-000000000003','system','5c000000-0000-4000-8000-00000000000a','5a000000-0000-4000-8000-0000000000ff',NULL,'A other user'),
 ('5e000000-0000-4000-8000-000000000004','system','5c000000-0000-4000-8000-00000000000a',NULL,'5d000000-0000-4000-8000-0000000000ff','A other device'),
 ('5e000000-0000-4000-8000-000000000005','system',NULL,'5a000000-0000-4000-8000-000000000001',NULL,'mine'),
 ('5e000000-0000-4000-8000-000000000006','system',NULL,NULL,NULL,'global'),
 ('5e000000-0000-4000-8000-000000000007','system','5c000000-0000-4000-8000-00000000000a',NULL,'5d000000-0000-4000-8000-000000000001','A my device'),
 ('5e000000-0000-4000-8000-000000000008','system',NULL,'5a000000-0000-4000-8000-000000000001','5d000000-0000-4000-8000-0000000000ff','mine on other device');
DO $$ DECLARE t text[]; BEGIN
  -- 账号授权 A+B，未选门店
  SELECT array_agg(title ORDER BY title) INTO t FROM handheld_notifications_changes('5a000000-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001',
    ARRAY['5c000000-0000-4000-8000-00000000000a','5c000000-0000-4000-8000-00000000000b']::uuid[],'0',0,200) WHERE title IS NOT NULL AND id::text LIKE '5e%';
  ASSERT t = ARRAY['A my device','A store','B store','global','mine','mine on other device'], 'SC1 all-locations scope: '||array_to_string(t,',');
  RAISE NOTICE 'PASS SC1 same-store notices targeted to another user/device do not leak';
  -- 显式当前门店 A
  SELECT array_agg(title ORDER BY title) INTO t FROM handheld_notifications_changes('5a000000-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001',
    ARRAY['5c000000-0000-4000-8000-00000000000a']::uuid[],'0',0,200) WHERE id::text LIKE '5e%';
  ASSERT t = ARRAY['A my device','A store','global','mine','mine on other device'], 'SC2 current-store scope: '||array_to_string(t,',');
  RAISE NOTICE 'PASS SC2 explicit store excludes other stores';
END $$;
