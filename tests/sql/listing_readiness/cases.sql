\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
CREATE FUNCTION t_assert(c boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT c THEN RAISE EXCEPTION 'FAIL %', label; END IF; RAISE NOTICE 'PASS %', label; END $$;
CREATE FUNCTION mk(p_id uuid, p_custom boolean) RETURNS void LANGUAGE sql AS $$
  INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price, image_paths)
  VALUES (p_id, 'porcelain', 100, '测试杯', p_id::text, p_custom, ARRAY['sku-listing/gallery/x/1.png']);
$$;
CREATE FUNCTION list(p_id uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO inv_stocks (sku_id, location_id, qty) VALUES (p_id, '00000000-0000-0000-0000-00000000000a', 1);
  INSERT INTO commerce_listings (sku_id, location_id, title, price, status, published_at)
  VALUES (p_id, '00000000-0000-0000-0000-00000000000a', '测试杯', 100, 'published', now());
$$;

-- 1 旧商品（迁移前就存在：无准备记录）照常发布
INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price) VALUES ('10000000-0000-0000-0000-000000000001','c',1,'旧','e1',true);
DELETE FROM listing_readiness WHERE sku_id = '10000000-0000-0000-0000-000000000001';
SELECT list('10000000-0000-0000-0000-000000000001');
SELECT t_assert((SELECT status='published' AND published_at IS NOT NULL AND NOT readiness_hold FROM commerce_listings WHERE sku_id='10000000-0000-0000-0000-000000000001'), 'legacy listing publishes unchanged');

-- 2 新自定义商品自动建准备记录；标准品不建
SELECT mk('20000000-0000-0000-0000-000000000002', true);
INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price) VALUES ('20000000-0000-0000-0000-0000000000f2','c',2,'标','ef2',false);
SELECT t_assert((SELECT count(*)=1 FROM listing_readiness WHERE sku_id IN ('20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-0000000000f2')), 'readiness row only for new custom single');

-- 3 未就绪上架意图被拦：hidden + hold + published_at 为空（所有公开入口都要求 published / published_at）
SELECT list('20000000-0000-0000-0000-000000000002');
SELECT t_assert((SELECT status='hidden' AND readiness_hold AND published_at IS NULL FROM commerce_listings WHERE sku_id='20000000-0000-0000-0000-000000000002'), 'not-ready publish intent held hidden');
-- 3b 准备中被售出：仍不可读
UPDATE commerce_listings SET status='sold' WHERE sku_id='20000000-0000-0000-0000-000000000002';
SELECT t_assert((SELECT published_at IS NULL AND readiness_hold FROM commerce_listings WHERE sku_id='20000000-0000-0000-0000-000000000002'), 'held listing sold stays unreadable');
UPDATE commerce_listings SET status='published' WHERE sku_id='20000000-0000-0000-0000-000000000002';

-- 4 图片任务运行中 → running，不放行
UPDATE listing_readiness SET images_settled=true WHERE sku_id='20000000-0000-0000-0000-000000000002';
INSERT INTO inv_listing_image_jobs (sku_id, source_bucket, source_path, status, readiness_revision) VALUES ('20000000-0000-0000-0000-000000000002','sku-raw','a.jpg','processing',1);
SELECT t_assert((SELECT listing_readiness_refresh('20000000-0000-0000-0000-000000000002')->>'image')='running', 'image running');
-- 5 图片失败 → failed，不放行；重试回到队列
UPDATE inv_listing_image_jobs SET status='permanent_failed', last_error='model_error' WHERE sku_id='20000000-0000-0000-0000-000000000002';
SELECT t_assert((SELECT listing_readiness_refresh('20000000-0000-0000-0000-000000000002')->>'image')='failed', 'image failed blocks');
SELECT t_assert((SELECT (listing_readiness_retry('20000000-0000-0000-0000-000000000002')->>'requeued_images')::int)=1, 'retry requeues failed image');
-- 6 旧修订任务成功不算数（过期回调）
UPDATE inv_listing_image_jobs SET status='succeeded', readiness_revision=0 WHERE sku_id='20000000-0000-0000-0000-000000000002';
INSERT INTO inv_listing_image_jobs (sku_id, source_bucket, source_path, status, readiness_revision) VALUES ('20000000-0000-0000-0000-000000000002','sku-raw','b.jpg','queued',1);
SELECT t_assert((SELECT listing_readiness_refresh('20000000-0000-0000-0000-000000000002')->>'image')='running', 'old-revision success ignored');
UPDATE inv_listing_image_jobs SET status='succeeded' WHERE sku_id='20000000-0000-0000-0000-000000000002';
SELECT t_assert((SELECT listing_readiness_refresh('20000000-0000-0000-0000-000000000002')->>'image')='succeeded', 'image succeeded at current revision');
SELECT t_assert((SELECT status='hidden' FROM commerce_listings WHERE sku_id='20000000-0000-0000-0000-000000000002'), 'no content yet still hidden');
-- 7 过期详情回调（修订不符）不落库
SELECT t_assert((SELECT listing_readiness_publish_content('20000000-0000-0000-0000-000000000002', 9, '[{"id":"h","type":"heading","text":"x"}]', '[]', 'template')->>'status')='stale', 'stale content callback rejected');
SELECT t_assert((SELECT count(*)=0 FROM inv_product_content WHERE sku_id='20000000-0000-0000-0000-000000000002'), 'stale wrote nothing');
-- 8 空内容失败
SELECT t_assert((SELECT listing_readiness_publish_content('20000000-0000-0000-0000-000000000002', 1, '[]', '[]', 'template')->>'status')='failed', 'empty content fails');
-- 9 正常完成 → 放行
SELECT t_assert((SELECT (listing_readiness_publish_content('20000000-0000-0000-0000-000000000002', 1, '[{"id":"h","type":"heading","text":"测试杯"}]', '[{"kind":"sku_facts"}]', 'template')->>'released')::int)=1, 'ready releases held listing');
SELECT t_assert((SELECT status='published' AND published_at IS NOT NULL AND NOT readiness_hold FROM commerce_listings WHERE sku_id='20000000-0000-0000-0000-000000000002'), 'listing now public');
-- 10 重复回调幂等，内容版本不变
SELECT t_assert((SELECT listing_readiness_publish_content('20000000-0000-0000-0000-000000000002', 1, '[{"id":"z","type":"heading","text":"别的"}]', '[]', 'template')->>'status')='replayed', 'duplicate callback replayed');
SELECT t_assert((SELECT version=1 AND published_blocks->0->>'text'='测试杯' FROM inv_product_content WHERE sku_id='20000000-0000-0000-0000-000000000002'), 'duplicate did not overwrite');

-- 11 已有人工发布内容：直接复用，不覆盖（零 AI 路径）
SELECT mk('30000000-0000-0000-0000-000000000003', true);
INSERT INTO inv_product_content (sku_id, version, published_blocks, published_version) VALUES ('30000000-0000-0000-0000-000000000003', 4, '[{"id":"m","type":"paragraph","text":"人工"}]', 4);
UPDATE listing_readiness SET images_settled=true WHERE sku_id='30000000-0000-0000-0000-000000000003';
SELECT list('30000000-0000-0000-0000-000000000003');
SELECT listing_readiness_refresh('30000000-0000-0000-0000-000000000003');
SELECT t_assert((SELECT listing_readiness_publish_content('30000000-0000-0000-0000-000000000003', 1, '[{"id":"a","type":"heading","text":"自动"}]', '[]', 'template')->>'status')='reused_existing', 'existing manual content reused');
SELECT t_assert((SELECT version=4 AND published_blocks->0->>'text'='人工' FROM inv_product_content WHERE sku_id='30000000-0000-0000-0000-000000000003'), 'manual content untouched');
SELECT t_assert((SELECT status='published' FROM commerce_listings WHERE sku_id='30000000-0000-0000-0000-000000000003'), 'reused content releases');

-- 12 无库存的店不会被放行；尺寸不在门禁内（无任何尺寸字段参与）
SELECT mk('40000000-0000-0000-0000-000000000004', true);
SELECT list('40000000-0000-0000-0000-000000000004');
UPDATE inv_stocks SET qty=0 WHERE sku_id='40000000-0000-0000-0000-000000000004';
UPDATE listing_readiness SET images_settled=true WHERE sku_id='40000000-0000-0000-0000-000000000004';
SELECT listing_readiness_refresh('40000000-0000-0000-0000-000000000004');
SELECT listing_readiness_publish_content('40000000-0000-0000-0000-000000000004', 1, '[{"id":"h","type":"heading","text":"x"}]', '[]', 'template');
SELECT t_assert((SELECT status='hidden' AND readiness_hold FROM commerce_listings WHERE sku_id='40000000-0000-0000-0000-000000000004'), 'no stock not released');

-- 13 缺图片/缺分类 → failed
SELECT mk('50000000-0000-0000-0000-000000000005', true);
UPDATE inv_skus SET image_paths='{}', category='' WHERE id='50000000-0000-0000-0000-000000000005';
UPDATE listing_readiness SET images_settled=true WHERE sku_id='50000000-0000-0000-0000-000000000005';
SELECT t_assert((SELECT r->>'image'='failed' AND r->>'recognition'='failed' FROM (SELECT listing_readiness_refresh('50000000-0000-0000-0000-000000000005') r) x), 'missing image/category fail');

-- 14 已公开 listing 后续更新不被门禁降级
UPDATE commerce_listings SET title='改名' WHERE sku_id='20000000-0000-0000-0000-000000000002';
SELECT t_assert((SELECT status='published' FROM commerce_listings WHERE sku_id='20000000-0000-0000-0000-000000000002'), 'published listing edit not demoted');

-- 15 权限：anon/authenticated 不能执行
SELECT t_assert(NOT has_function_privilege('authenticated','listing_readiness_retry(uuid)','EXECUTE') AND NOT has_function_privilege('anon','listing_readiness_publish_content(uuid,integer,jsonb,jsonb,text)','EXECUTE') AND NOT has_table_privilege('authenticated','listing_readiness','SELECT'), 'service-role only');
