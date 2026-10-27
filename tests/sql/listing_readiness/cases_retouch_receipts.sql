-- Run in isolated readiness_test only, after 0112 and fixtures.
UPDATE inv_product_content SET published_blocks='[{"type":"text","text":"facts"}]'
WHERE sku_id='b2700000-0000-0000-0000-000000000004';
UPDATE inv_skus SET image_paths=ARRAY['sku-listing/test/manual.png'] WHERE id='b2700000-0000-0000-0000-000000000004';
INSERT INTO storage.objects(bucket_id,name) VALUES('sku-listing','test/manual.png');
UPDATE listing_readiness SET recognition_status='succeeded',recognition_revision=input_revision,image_status='succeeded',image_revision=input_revision,content_status='succeeded',content_revision=input_revision,images_settled=true WHERE sku_id='b2700000-0000-0000-0000-000000000004';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'manual output without protected receipt blocked');
-- Test fixtures bypass issuance orchestration only to exercise DB gate independently.
INSERT INTO inv_defect_retouch_receipts(image_path,source,actor_user_id,validation_version,device_id,bound_sku_id)
VALUES('sku-listing/test/manual.png','validated_retouch','00000000-0000-0000-0000-000000000001',1,'00000000-0000-0000-0000-000000000002','b2700000-0000-0000-0000-000000000004');
SELECT strict_assert(listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'verified manual output with real object and SKU binding accepted without gallery job');
UPDATE inv_defect_retouch_receipts SET validation_version=0 WHERE image_path='sku-listing/test/manual.png';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'old unreliable receipt blocked');
UPDATE inv_defect_retouch_receipts SET validation_version=1,bound_sku_id='b2700000-0000-0000-0000-000000000002' WHERE image_path='sku-listing/test/manual.png';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'other SKU receipt blocked');
UPDATE inv_defect_retouch_receipts SET bound_sku_id='b2700000-0000-0000-0000-000000000004',source='preserved_original' WHERE image_path='sku-listing/test/manual.png';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'preserved original receipt blocked');
UPDATE inv_defect_retouch_receipts SET source='validated_retouch',actor_user_id=NULL WHERE image_path='sku-listing/test/manual.png';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'missing actor blocked');
UPDATE inv_defect_retouch_receipts SET actor_user_id='00000000-0000-0000-0000-000000000001' WHERE image_path='sku-listing/test/manual.png';
DELETE FROM storage.objects WHERE name='test/manual.png';
SELECT strict_assert(NOT listing_readiness_is_ready('b2700000-0000-0000-0000-000000000004'),'receipt without actual object blocked');
SELECT strict_assert(NOT has_table_privilege('authenticated','inv_defect_retouch_receipts','INSERT'),'client cannot forge receipts');
SELECT strict_assert(NOT has_function_privilege('authenticated','listing_image_has_success_receipt(uuid,text)','EXECUTE'),'receipt gate service only');
INSERT INTO storage.objects(bucket_id,name) VALUES('sku-listing','test/00000000-0000-0000-0000-000000000002/bind.png');
UPDATE inv_skus SET image_paths=ARRAY['sku-listing/test/00000000-0000-0000-0000-000000000002/bind.png'] WHERE id='b2700000-0000-0000-0000-000000000004';
INSERT INTO inv_defect_retouch_receipts(image_path,source,actor_user_id,validation_version,device_id)
VALUES('sku-listing/test/00000000-0000-0000-0000-000000000002/bind.png','validated_retouch','00000000-0000-0000-0000-000000000001',1,'00000000-0000-0000-0000-000000000002');
INSERT INTO handheld_item_audit(sku_id,actor_user_id,device_id,action,changed_fields,after_snapshot)
VALUES('b2700000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','update',ARRAY['image_paths'],'{"image_paths":["sku-listing/test/00000000-0000-0000-0000-000000000002/bind.png"]}');
SELECT strict_assert((SELECT bound_sku_id IS NULL FROM inv_defect_retouch_receipts WHERE image_path LIKE '%/bind.png'),'other actor save cannot bind receipt');
INSERT INTO handheld_item_audit(sku_id,actor_user_id,device_id,action,changed_fields,after_snapshot)
VALUES('b2700000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','update',ARRAY['image_paths'],'{"image_paths":["sku-listing/test/00000000-0000-0000-0000-000000000002/bind.png"]}');
SELECT strict_assert((SELECT bound_sku_id='b2700000-0000-0000-0000-000000000004' FROM inv_defect_retouch_receipts WHERE image_path LIKE '%/bind.png'),'verified same actor save binds once');