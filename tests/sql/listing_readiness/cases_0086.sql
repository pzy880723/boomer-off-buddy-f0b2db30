\set ON_ERROR_STOP 1
-- 0086：真实表 updated_by NOT NULL。系统模板 / 存量补齐写入必须用系统自动化身份，不冒充上传员工；人工身份经备份/回滚保留。
-- U0 NOT NULL 未放宽：不带 updated_by 的直接写入仍被拒
DO $$ BEGIN
  BEGIN
    INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price) VALUES ('d8600000-0000-0000-0000-000000000000','porcelain',100,'空','d86-0',false);
    INSERT INTO inv_product_content (sku_id, version) VALUES ('d8600000-0000-0000-0000-000000000000', 0);
    RAISE EXCEPTION 'expected not-null violation';
  EXCEPTION WHEN not_null_violation THEN NULL; END;
END $$;
SELECT t2(true, 'U0 updated_by NOT NULL still enforced');
SELECT t2(content_system_actor() = 'a0700000-0000-4000-8000-000000000001'
  AND NOT has_function_privilege('authenticated','content_system_actor()','EXECUTE')
  AND NOT has_function_privilege('anon','content_system_actor()','EXECUTE'), 'U0 system actor fixed and service-only');

-- U1 新孤品上架：readiness 模板首次写详情（INSERT 分支）成功，updated_by = 系统身份，不是上传员工
INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price, image_paths)
VALUES ('d8600000-0000-0000-0000-000000000001','porcelain',100,'新杯','d86-1',true,'{}');
UPDATE listing_readiness SET image_ai_actor='e1000000-0000-0000-0000-0000000000bb', images_settled=true, image_status='succeeded',
  image_revision=input_revision, recognition_status='succeeded', recognition_revision=input_revision
 WHERE sku_id='d8600000-0000-0000-0000-000000000001';
SELECT t2(listing_readiness_publish_content('d8600000-0000-0000-0000-000000000001', 1,
  '[{"id":"h","type":"heading","text":"新杯"}]', '[{"kind":"sku_facts"}]', 'template')->>'status'='template', 'U1 readiness template insert succeeds');
SELECT t2((SELECT updated_by=content_system_actor() AND updated_by<>'e1000000-0000-0000-0000-0000000000bb' AND version=1 AND published_version=1
  FROM inv_product_content WHERE sku_id='d8600000-0000-0000-0000-000000000001'), 'U1 updated_by is system actor, not uploader');

-- U2 存量补齐新行：updated_by = 系统身份
SELECT bf_mk('d8600000-0000-0000-0000-000000000002');
SELECT t2(bf('d8600000-0000-0000-0000-000000000002', NULL)->>'status'='filled', 'U2 backfill insert succeeds');
SELECT t2((SELECT updated_by=content_system_actor() FROM inv_product_content WHERE sku_id='d8600000-0000-0000-0000-000000000002'), 'U2 backfill row by system actor');
SELECT t2(product_content_backfill_restore('d8600000-0000-0000-0000-000000000002')->>'status'='restored'
  AND NOT EXISTS (SELECT 1 FROM inv_product_content WHERE sku_id='d8600000-0000-0000-0000-000000000002'), 'U2 restore removes system row');

-- U3 存量补齐人工空草稿行：写入身份换成系统，备份保留人工身份，回滚恢复人工 updated_by/updated_at/草稿
SELECT bf_mk('d8600000-0000-0000-0000-000000000003');
INSERT INTO inv_product_content (sku_id, version, draft_blocks, published_blocks, updated_by, updated_at)
VALUES ('d8600000-0000-0000-0000-000000000003', 2, '[{"id":"d","type":"paragraph","text":"草稿"}]', '[]', 'e1000000-0000-0000-0000-0000000000aa', '2026-01-01T00:00:00Z');
SELECT t2(bf('d8600000-0000-0000-0000-000000000003', 2)->>'status'='filled', 'U3 backfill over manual empty row');
SELECT t2((SELECT updated_by=content_system_actor() AND draft_blocks->0->>'text'='草稿'
  AND auto_backfill_backup->>'updated_by'='e1000000-0000-0000-0000-0000000000aa' FROM inv_product_content WHERE sku_id='d8600000-0000-0000-0000-000000000003'),
  'U3 system writer, manual draft and editor kept in backup');
SELECT t2(product_content_backfill_restore('d8600000-0000-0000-0000-000000000003')->>'status'='restored', 'U3 restore ok');
SELECT t2((SELECT updated_by='e1000000-0000-0000-0000-0000000000aa' AND updated_at='2026-01-01T00:00:00Z' AND version=2
  AND draft_blocks->0->>'text'='草稿' AND published_blocks='[]' FROM inv_product_content WHERE sku_id='d8600000-0000-0000-0000-000000000003'),
  'U3 restore brings back manual editor');

-- U4 补齐后人工编辑：人工 updated_by 保留，回滚拒绝
SELECT t2(bf('d8600000-0000-0000-0000-000000000003', 2)->>'status'='filled', 'U4 refill');
UPDATE inv_product_content SET version=version+1, published_version=version+1, updated_by='e1000000-0000-0000-0000-0000000000aa',
  published_blocks='[{"id":"m","type":"paragraph","text":"人工改"}]' WHERE sku_id='d8600000-0000-0000-0000-000000000003';
SELECT t2(product_content_backfill_restore('d8600000-0000-0000-0000-000000000003')->>'status'='edited_since'
  AND (SELECT updated_by='e1000000-0000-0000-0000-0000000000aa' FROM inv_product_content WHERE sku_id='d8600000-0000-0000-0000-000000000003'),
  'U4 manual editor preserved after edit');

-- U5 readiness 模板 UPDATE 分支（已有空行）：同样记系统身份
INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price, image_paths)
VALUES ('d8600000-0000-0000-0000-000000000005','porcelain',100,'空行杯','d86-5',true,'{}');
INSERT INTO inv_product_content (sku_id, version, updated_by) VALUES ('d8600000-0000-0000-0000-000000000005', 0, 'e1000000-0000-0000-0000-0000000000aa');
SELECT t2(listing_readiness_publish_content('d8600000-0000-0000-0000-000000000005', 1,
  '[{"id":"h","type":"heading","text":"空行杯"}]', '[]', 'template')->>'status'='template'
  AND (SELECT updated_by=content_system_actor() AND version=1 FROM inv_product_content WHERE sku_id='d8600000-0000-0000-0000-000000000005'),
  'U5 readiness template update by system actor');
