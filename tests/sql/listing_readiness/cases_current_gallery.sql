-- Synthetic records in local readiness_test only, never production data.
UPDATE inv_skus SET image_paths=ARRAY['sku-listing/test/reuse-cover.png','sku-listing/test/reuse-detail.png']
WHERE id='b2700000-0000-0000-0000-000000000004';
INSERT INTO storage.objects(bucket_id,name) VALUES('sku-listing','test/reuse-cover.png'),('sku-listing','test/reuse-detail.png');
INSERT INTO inv_listing_image_jobs(sku_id,source_bucket,source_path,target_path,status,readiness_revision)
VALUES('b2700000-0000-0000-0000-000000000004','sku-raw','test/reuse-cover.jpg','test/reuse-cover.png','succeeded',1),
('b2700000-0000-0000-0000-000000000004','sku-raw','test/reuse-detail.jpg','test/reuse-detail.png','succeeded',1);
DELETE FROM inv_product_content_image_jobs WHERE sku_id='b2700000-0000-0000-0000-000000000004';
\i /tmp/auto-gallery-fixture.sql
UPDATE listing_readiness SET image_plan='ai',images_settled=true,recognition_status='succeeded',recognition_revision=input_revision,
image_status='succeeded',image_revision=input_revision,content_status='succeeded',content_revision=input_revision
WHERE sku_id='b2700000-0000-0000-0000-000000000004';
SELECT strict_assert(listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'real auto-cover and auto-detail gallery outputs ready without duplicate detail jobs');
SELECT strict_assert(listing_readiness_detail_images_state('b2700000-0000-0000-0000-000000000004')='succeeded','current gallery details have succeeded state');
SELECT strict_assert((SELECT count(*)=0 FROM inv_product_content_image_jobs WHERE sku_id='b2700000-0000-0000-0000-000000000004'),'proof creates no fake detail jobs');
SELECT strict_assert((listing_readiness_publish_content('b2700000-0000-0000-0000-000000000004',(SELECT input_revision FROM listing_readiness WHERE sku_id='b2700000-0000-0000-0000-000000000004'),'[]','[]','template')->>'status')='replayed','content replay preserves gate');
SELECT strict_assert(listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'content replay allows proven gallery');
UPDATE listing_readiness SET content_status='pending',auto_content_version=(SELECT version FROM inv_product_content WHERE sku_id='b2700000-0000-0000-0000-000000000004') WHERE sku_id='b2700000-0000-0000-0000-000000000004';
SELECT strict_assert((listing_readiness_publish_content('b2700000-0000-0000-0000-000000000004',(SELECT input_revision FROM listing_readiness WHERE sku_id='b2700000-0000-0000-0000-000000000004'),(SELECT published_blocks FROM inv_product_content WHERE sku_id='b2700000-0000-0000-0000-000000000004'),'[]','template')->>'status')='template_replaced','current publish accepts actual builder gallery content');
SELECT strict_assert(listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'current content publication remains ready with gallery reuse');
UPDATE listing_readiness SET input_revision=input_revision+1 WHERE sku_id='b2700000-0000-0000-0000-000000000004';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'new revision remains blocked');
SELECT strict_assert((listing_readiness_publish_content('b2700000-0000-0000-0000-000000000004',1,'[]','[]','template')->>'status')='stale','old content publish revision rejected');
UPDATE listing_readiness SET recognition_revision=input_revision,image_revision=input_revision,content_revision=input_revision WHERE sku_id='b2700000-0000-0000-0000-000000000004';
DELETE FROM storage.objects WHERE name='test/reuse-detail.png';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'gallery receipt missing object blocks');
SELECT strict_assert(listing_readiness_detail_images_state('b2700000-0000-0000-0000-000000000004')='failed','missing detail object fails detail state');
INSERT INTO storage.objects(bucket_id,name) VALUES('sku-listing','test/reuse-detail.png');
UPDATE inv_listing_image_jobs SET status='permanent_failed' WHERE target_path='test/reuse-detail.png';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'failed gallery receipt blocks');
INSERT INTO inv_defect_retouch_receipts(image_path,source,actor_user_id,validation_version,device_id,bound_sku_id)
VALUES('sku-listing/test/reuse-detail.png','validated_retouch','00000000-0000-0000-0000-000000000001',1,'00000000-0000-0000-0000-000000000002','b2700000-0000-0000-0000-000000000004');
SELECT strict_assert(listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'bound version1 retouch current gallery reused detail accepted');
UPDATE inv_defect_retouch_receipts SET validation_version=0 WHERE image_path='sku-listing/test/reuse-detail.png';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'version0 retouch gallery detail rejected');
UPDATE inv_defect_retouch_receipts SET validation_version=1,bound_sku_id='b2700000-0000-0000-0000-000000000002' WHERE image_path='sku-listing/test/reuse-detail.png';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'other SKU retouch rejected');
UPDATE inv_defect_retouch_receipts SET bound_sku_id='b2700000-0000-0000-0000-000000000004',source='preserved_original' WHERE image_path='sku-listing/test/reuse-detail.png';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'preserved original rejected');
UPDATE inv_listing_image_jobs SET status='succeeded' WHERE target_path='test/reuse-detail.png';
UPDATE inv_skus SET image_paths=ARRAY['sku-listing/test/reuse-cover.png'] WHERE id='b2700000-0000-0000-0000-000000000004';
UPDATE listing_readiness SET images_settled=true,recognition_status='succeeded',recognition_revision=input_revision,image_status='succeeded',image_revision=input_revision,content_status='succeeded',content_revision=input_revision WHERE sku_id='b2700000-0000-0000-0000-000000000004';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'historical gallery not currently referenced rejected');
INSERT INTO inv_product_content_image_jobs(sku_id,block_id,source_path,target_path,status) VALUES('b2700000-0000-0000-0000-000000000004','auto-detail-1','sku-raw/test/detail-src.jpg','sku-listing/test/reuse-detail.png','succeeded');
SELECT strict_assert(listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'independent detail success with object accepted');
UPDATE inv_product_content_image_jobs SET status='retryable_failed' WHERE block_id='auto-detail-1' AND sku_id='b2700000-0000-0000-0000-000000000004';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'unrepaired independent detail blocked');
SELECT strict_assert(listing_readiness_detail_images_state('b2700000-0000-0000-0000-000000000004')='running','current independent retry reflected as running');
UPDATE inv_product_content_image_jobs SET status='permanent_failed' WHERE block_id='auto-detail-1' AND sku_id='b2700000-0000-0000-0000-000000000004';
SELECT strict_assert(listing_readiness_detail_images_state('b2700000-0000-0000-0000-000000000004')='failed','current independent terminal failure reflected');
UPDATE inv_product_content SET published_blocks='[{"type":"image","id":"raw","storage_path":"sku-raw/test/reuse-cover.jpg"}]' WHERE sku_id='b2700000-0000-0000-0000-000000000004';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'raw detail blocks');
SELECT strict_assert(NOT has_function_privilege('authenticated','listing_detail_image_has_success_receipt(uuid,text,text)','EXECUTE'),'detail proof service only');