\set ON_ERROR_STOP 1
-- 存量详情补齐：只补公开空详情孤品；CAS；跳过准备中/图片未完成；幂等；备份回滚；详情读取带来源。
CREATE FUNCTION bf_mk(p uuid, p_custom boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price, image_paths)
  VALUES (p, 'porcelain', 100, '存量碗', p::text, p_custom, ARRAY['sku-listing/old/'||p||'.png']);
  DELETE FROM listing_readiness WHERE sku_id = p;
  INSERT INTO inv_stocks (sku_id, location_id, qty) VALUES (p, '00000000-0000-0000-0000-00000000000a', 1);
  INSERT INTO commerce_listings (sku_id, location_id, title, price, status, published_at)
  VALUES (p, '00000000-0000-0000-0000-00000000000a', '存量碗', 100, 'published', now()); END $$;
CREATE FUNCTION bf_blocks() RETURNS jsonb LANGUAGE sql AS $$ SELECT '[{"id":"auto-title","type":"heading","text":"存量碗"}]'::jsonb $$;
CREATE FUNCTION bf_src() RETURNS jsonb LANGUAGE sql AS $$ SELECT '[{"kind":"sku_facts","sku_id":"x"}]'::jsonb $$;
CREATE FUNCTION bf(p uuid, v int) RETURNS jsonb LANGUAGE sql AS $$ SELECT product_content_backfill_apply(p, v, bf_blocks(), bf_src(), 'auto-content-v1') $$;

SELECT bf_mk('c1000000-0000-0000-0000-000000000001');
SELECT t2(product_content_backfill_block_reason('c1000000-0000-0000-0000-000000000001') IS NULL, 'B1 public empty legacy sku is a candidate');
SELECT t2(bf('c1000000-0000-0000-0000-000000000001', NULL)->>'status'='filled', 'B1 filled');
SELECT t2((SELECT published_blocks=bf_blocks() AND version=1 AND auto_sources->>'builder_version'='auto-content-v1'
  AND auto_sources->'sources'=bf_src() AND auto_backfill_backup='{"existed":false}' FROM inv_product_content
  WHERE sku_id='c1000000-0000-0000-0000-000000000001'), 'B1 sources/version and backup persisted');
SELECT t2((published_product_content('c1000000-0000-0000-0000-000000000001')->'auto_sources')=bf_src()
  AND jsonb_array_length(published_product_content('c1000000-0000-0000-0000-000000000001')->'published_blocks')=1,
  'B1 detail read returns blocks + sources in one call');
SELECT t2(bf('c1000000-0000-0000-0000-000000000001', NULL)->>'status'='already_filled', 'B2 retry idempotent');

-- B3 现有非空详情不改
SELECT bf_mk('c1000000-0000-0000-0000-000000000003');
INSERT INTO inv_product_content (sku_id, version, draft_blocks, published_blocks, published_version, updated_by)
VALUES ('c1000000-0000-0000-0000-000000000003', 4, '[]', '[{"id":"m","type":"paragraph","text":"人工"}]', 4, 'e1000000-0000-0000-0000-0000000000aa');
SELECT t2(bf('c1000000-0000-0000-0000-000000000003', 4)->>'reason'='has_content'
  AND (SELECT version=4 AND published_blocks->0->>'text'='人工' FROM inv_product_content WHERE sku_id='c1000000-0000-0000-0000-000000000003'),
  'B3 existing non-empty content untouched');

-- B4 人工并发：dry-run 读到无行，执行前人工建了空草稿行 → conflict；读到 version 后再改 → conflict
SELECT bf_mk('c1000000-0000-0000-0000-000000000004');
INSERT INTO inv_product_content (sku_id, version, draft_blocks, published_blocks, updated_by) VALUES ('c1000000-0000-0000-0000-000000000004', 2, '[{"id":"d","type":"paragraph","text":"草稿"}]', '[]', 'e1000000-0000-0000-0000-0000000000aa');
SELECT t2(bf('c1000000-0000-0000-0000-000000000004', NULL)->>'status'='conflict', 'B4 CAS: row appeared since dry-run');
SELECT t2(bf('c1000000-0000-0000-0000-000000000004', 1)->>'status'='conflict', 'B4 CAS: stale version');
SELECT t2(bf('c1000000-0000-0000-0000-000000000004', 2)->>'status'='filled', 'B4 matching version fills');
SELECT t2((SELECT draft_blocks->0->>'text'='草稿' AND version=3 FROM inv_product_content WHERE sku_id='c1000000-0000-0000-0000-000000000004'),
  'B4 matching version fills, keeps manual draft');
-- B5 回滚：恢复原行
SELECT t2(product_content_backfill_restore('c1000000-0000-0000-0000-000000000004')->>'status'='restored', 'B5 restore ok');
SELECT t2((SELECT version=2 AND published_blocks='[]' AND draft_blocks->0->>'text'='草稿' AND auto_sources IS NULL FROM inv_product_content WHERE sku_id='c1000000-0000-0000-0000-000000000004'),
  'B5 restore brings back original row');
SELECT t2(product_content_backfill_restore('c1000000-0000-0000-0000-000000000001')->>'status'='restored', 'B5 restore new-row ok');
SELECT t2(NOT EXISTS (SELECT 1 FROM inv_product_content WHERE sku_id='c1000000-0000-0000-0000-000000000001'), 'B5 restore removes row that did not exist');
SELECT t2(bf('c1000000-0000-0000-0000-000000000001', NULL)->>'status'='filled', 'B5 refill after restore works');
-- B6 补齐后人工编辑 → 回滚拒绝，详情不再把自动来源挂到人工内容上
UPDATE inv_product_content SET version=version+1, published_version=version+1, published_blocks='[{"id":"m","type":"paragraph","text":"改"}]'
 WHERE sku_id='c1000000-0000-0000-0000-000000000001';
SELECT t2(product_content_backfill_restore('c1000000-0000-0000-0000-000000000001')->>'status'='edited_since', 'B6 restore refused after manual edit');
SELECT t2((published_product_content('c1000000-0000-0000-0000-000000000001')->>'auto_sources') IS NULL, 'B6 manual edit after fill wins');
SELECT t2(bf('c1000000-0000-0000-0000-000000000001', 2)->>'reason'='has_content', 'B6 no overwrite of later manual edit');

-- B7 跳过：准备中 / 图片任务未完成 / 详情图片任务未完成 / 未公开 / 标准品
SELECT bf_mk('c1000000-0000-0000-0000-000000000007');
INSERT INTO listing_readiness (sku_id, images_settled) VALUES ('c1000000-0000-0000-0000-000000000007', false);
SELECT t2(bf('c1000000-0000-0000-0000-000000000007', NULL)->>'reason'='readiness_managed', 'B7 readiness-managed skipped');
SELECT bf_mk('c1000000-0000-0000-0000-000000000008');
INSERT INTO inv_listing_image_jobs (sku_id, source_bucket, source_path, status) VALUES ('c1000000-0000-0000-0000-000000000008','sku-raw','a.jpg','permanent_failed');
SELECT t2(bf('c1000000-0000-0000-0000-000000000008', NULL)->>'reason'='image_jobs_unfinished', 'B7 failed image job skipped');
SELECT bf_mk('c1000000-0000-0000-0000-000000000009');
INSERT INTO inv_product_content_image_jobs (sku_id, block_id, source_path, status) VALUES ('c1000000-0000-0000-0000-000000000009','b','sku-raw/x.jpg','queued');
SELECT t2(bf('c1000000-0000-0000-0000-000000000009', NULL)->>'reason'='detail_image_jobs_unfinished', 'B7 detail image job skipped');
SELECT bf_mk('c1000000-0000-0000-0000-00000000000a');
UPDATE commerce_listings SET status='hidden' WHERE sku_id='c1000000-0000-0000-0000-00000000000a';
SELECT t2(bf('c1000000-0000-0000-0000-00000000000a', NULL)->>'reason'='not_published', 'B7 hidden listing skipped');
SELECT bf_mk('c1000000-0000-0000-0000-00000000000b', false);
SELECT t2(bf('c1000000-0000-0000-0000-00000000000b', NULL)->>'reason'='not_public_single', 'B7 standard sku skipped');
SELECT t2(bf('c1000000-0000-0000-0000-00000000000c', NULL)->>'reason'='missing_sku', 'B7 unknown sku skipped');
SELECT bf_mk('c1000000-0000-0000-0000-00000000000d');
SELECT t2(product_content_backfill_apply('c1000000-0000-0000-0000-00000000000d', NULL, '[]', bf_src(), 'v1')->>'reason'='empty_blocks', 'B7 empty blocks refused');
SELECT t2(NOT has_function_privilege('authenticated','product_content_backfill_apply(uuid,integer,jsonb,jsonb,text)','EXECUTE')
  AND NOT has_function_privilege('anon','product_content_backfill_restore(uuid)','EXECUTE')
  AND has_function_privilege('service_role','product_content_backfill_apply(uuid,integer,jsonb,jsonb,text)','EXECUTE'), 'B8 service-only');
