-- New requirements: no raw/legacy/custom bypass; standard sharing unaffected.
CREATE OR REPLACE FUNCTION strict_assert(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF; RAISE NOTICE 'PASS %',label; END $$;
INSERT INTO inv_skus(id,category,price_tier,name,epc,is_custom_price,kind,inventory_policy,image_paths)
VALUES ('b2700000-0000-0000-0000-000000000001','c',1,'raw decline','strict1',true,'single','tracked',ARRAY['sku-raw/test/a.jpg']),
('b2700000-0000-0000-0000-000000000002','c',1,'legacy','strict2',true,'single','tracked',ARRAY['sku-listing/test/a.png']),
('b2700000-0000-0000-0000-000000000003','c',1,'standard','strict3',false,'single','unlimited',ARRAY['sku-raw/test/a.jpg']);
UPDATE listing_readiness SET image_plan='raw_declined',images_settled=true,recognition_status='succeeded',recognition_revision=input_revision,
image_status='succeeded',image_revision=input_revision,content_status='succeeded',content_revision=input_revision
WHERE sku_id='b2700000-0000-0000-0000-000000000001';
INSERT INTO inv_product_content(sku_id,version,published_version,updated_by,published_blocks)
VALUES ('b2700000-0000-0000-0000-000000000001',1,1,'00000000-0000-0000-0000-000000000001','[{"type":"text","text":"facts"}]');
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000001'),'raw_declined never ready');
DELETE FROM listing_readiness WHERE sku_id='b2700000-0000-0000-0000-000000000002';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000002'),'missing legacy custom readiness blocks');
UPDATE listing_readiness SET images_settled=true,recognition_status='succeeded',recognition_revision=input_revision,
image_status='succeeded',image_revision=input_revision,content_status='succeeded',content_revision=input_revision
WHERE sku_id='b2700000-0000-0000-0000-000000000003';
INSERT INTO inv_product_content(sku_id,version,published_version,updated_by,published_blocks)
VALUES ('b2700000-0000-0000-0000-000000000003',1,1,'00000000-0000-0000-0000-000000000001','[{"type":"text","text":"facts"}]');
SELECT strict_assert(listing_readiness_is_ready('b2700000-0000-0000-0000-000000000003'),'standard raw unchanged');
INSERT INTO commerce_listings(sku_id,location_id,title,price,status,published_at)
VALUES ('b2700000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000a','legacy',1,'published',now());
SELECT strict_assert((SELECT status='hidden' AND readiness_hold AND published_at IS NULL FROM commerce_listings WHERE sku_id='b2700000-0000-0000-0000-000000000002'),'manual legacy publication held');
SELECT strict_assert(NOT EXISTS(SELECT 1 FROM storefront_ready_listings WHERE sku_id='b2700000-0000-0000-0000-000000000002'),'legacy excluded from DB public read view');
SELECT strict_assert(published_product_content('b2700000-0000-0000-0000-000000000001') IS NULL,'raw decline content not public');
SELECT strict_assert(NOT has_function_privilege('authenticated','storefront_ready_skus(uuid[])','EXECUTE'),'eligibility helper service-only');
SELECT strict_assert((SELECT count(*)=0 FROM storefront_ready_skus(ARRAY['b2700000-0000-0000-0000-000000000001'::uuid,'b2700000-0000-0000-0000-000000000002'::uuid])),'batch eligibility excludes declined and missing receipts');
INSERT INTO inv_skus(id,category,price_tier,name,epc,is_custom_price,kind,inventory_policy,image_paths)
VALUES ('b2700000-0000-0000-0000-000000000004','c',1,'ready fixture','readyfixture',true,'single','tracked',ARRAY['sku-listing/test/success.png']);
UPDATE listing_readiness SET image_plan='ai',images_settled=true,recognition_status='succeeded',recognition_revision=input_revision,
image_status='succeeded',image_revision=input_revision,content_status='succeeded',content_revision=input_revision
WHERE sku_id='b2700000-0000-0000-0000-000000000004';
INSERT INTO inv_listing_image_jobs(sku_id,source_bucket,source_path,target_path,status,readiness_revision)
VALUES ('b2700000-0000-0000-0000-000000000004','sku-raw','test/success.jpg','test/success.png','succeeded',1);
INSERT INTO storage.objects(bucket_id,name) VALUES('sku-listing','test/success.png');
INSERT INTO inv_product_content(sku_id,version,published_version,updated_by,published_blocks)
VALUES ('b2700000-0000-0000-0000-000000000004',1,1,'00000000-0000-0000-0000-000000000001','[{"type":"text","text":"facts"}]');
SELECT strict_assert(listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'successful current gallery and content ready');
UPDATE inv_product_content SET published_blocks='[{"type":"image","id":"detail","storage_path":"sku-listing/test/detail.png"}]' WHERE sku_id='b2700000-0000-0000-0000-000000000004';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'detail without successful job blocks');
INSERT INTO inv_product_content_image_jobs(sku_id,block_id,source_path,target_path,status)
VALUES('b2700000-0000-0000-0000-000000000004','detail','sku-raw/test/detail.jpg','sku-listing/test/detail.png','succeeded');
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'detail receipt without output object blocks');
INSERT INTO storage.objects(bucket_id,name) VALUES('sku-listing','test/detail.png');
SELECT strict_assert(listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'successful detail with real object ready');
UPDATE listing_readiness SET input_revision=input_revision+1 WHERE sku_id='b2700000-0000-0000-0000-000000000004';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'new revision invalidates old readiness');