-- Isolated fixture only. No production backfill or job execution.
CREATE TABLE IF NOT EXISTS inv_categories(code text,name text,is_active boolean);
INSERT INTO inv_categories(code,name,is_active) VALUES('legacy_test','玩具模型',true);
INSERT INTO inv_skus(id,category,price_tier,name,epc,is_custom_price,kind,inventory_policy,image_paths,created_at)
VALUES('b2700000-0000-0000-0000-000000000010','legacy_test',1,'真实旧品','legacy_proven',true,'single','tracked',ARRAY['sku-listing/test/legacy.png'],'2026-10-01T00:00:00Z');
DELETE FROM listing_readiness WHERE sku_id='b2700000-0000-0000-0000-000000000010';
INSERT INTO storage.objects(bucket_id,name) VALUES('sku-listing','test/legacy.png');
INSERT INTO inv_listing_image_jobs(sku_id,source_bucket,source_path,target_path,status,readiness_revision)
VALUES('b2700000-0000-0000-0000-000000000010','sku-raw','test/legacy.jpg','test/legacy.png','succeeded',1);
INSERT INTO inv_product_content(sku_id,version,published_version,updated_by,published_blocks)
VALUES('b2700000-0000-0000-0000-000000000010',1,1,'00000000-0000-0000-0000-000000000001','[{"type":"text","text":"真实介绍"},{"type":"image","id":"galleryreuse","storage_path":"sku-listing/test/legacy.png"}]');
INSERT INTO commerce_listings(sku_id,location_id,title,price,status) VALUES('b2700000-0000-0000-0000-000000000010','00000000-0000-0000-0000-00000000000a','旧品',1,'hidden');
SELECT strict_assert(storefront_image_ready('b2700000-0000-0000-0000-000000000010'),'legacy real gallery reused in content reads without later readiness metadata');
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000010'),'legacy read compatibility does not bypass strict publish writer');
UPDATE inv_listing_image_jobs SET status='permanent_failed' WHERE sku_id='b2700000-0000-0000-0000-000000000010';
SELECT strict_assert(NOT storefront_image_ready('b2700000-0000-0000-0000-000000000010'),'legacy missing successful receipt blocked');
UPDATE inv_listing_image_jobs SET status='succeeded' WHERE sku_id='b2700000-0000-0000-0000-000000000010';
DELETE FROM storage.objects WHERE name='test/legacy.png';
SELECT strict_assert(NOT storefront_image_ready('b2700000-0000-0000-0000-000000000010'),'legacy missing real file blocked');
INSERT INTO storage.objects(bucket_id,name) VALUES('sku-listing','test/legacy.png');
UPDATE inv_product_content SET published_blocks='[{"type":"image","id":"raw","storage_path":"sku-raw/test/raw.jpg"}]' WHERE sku_id='b2700000-0000-0000-0000-000000000010';
SELECT strict_assert(NOT storefront_image_ready('b2700000-0000-0000-0000-000000000010'),'legacy raw detail image blocked');
UPDATE inv_product_content SET published_blocks='[]' WHERE sku_id='b2700000-0000-0000-0000-000000000010';
SELECT strict_assert(NOT storefront_image_ready('b2700000-0000-0000-0000-000000000010'),'legacy empty content blocked');
UPDATE inv_product_content SET published_blocks='[{"type":"text","text":"真实介绍"}]' WHERE sku_id='b2700000-0000-0000-0000-000000000010';
UPDATE inv_categories SET name='unknown' WHERE code='legacy_test';
SELECT strict_assert(NOT storefront_image_ready('b2700000-0000-0000-0000-000000000010'),'legacy missing Chinese category blocked');
UPDATE inv_categories SET name='玩具模型' WHERE code='legacy_test';
UPDATE inv_skus SET name=' ' WHERE id='b2700000-0000-0000-0000-000000000010';
SELECT strict_assert(NOT storefront_image_ready('b2700000-0000-0000-0000-000000000010'),'legacy missing name blocked');
UPDATE inv_skus SET name='真实旧品' WHERE id='b2700000-0000-0000-0000-000000000010';
INSERT INTO listing_readiness(sku_id,image_status,recognition_status,content_status) VALUES('b2700000-0000-0000-0000-000000000010','failed','succeeded','succeeded');
SELECT strict_assert(NOT storefront_image_ready('b2700000-0000-0000-0000-000000000010'),'existing readiness failure never uses legacy fallback');