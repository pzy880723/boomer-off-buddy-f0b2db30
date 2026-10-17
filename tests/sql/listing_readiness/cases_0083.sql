\set ON_ERROR_STOP 1
-- 0083 回归：标准品复用追加照片在建品原事务内完成；本次员工/计划持久化；回放/跨 op/worker 先完成均不复活原图。
CREATE FUNCTION scR(p_op text, p_actor uuid, p_paths text[], p_plan text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN RETURN handheld_smart_create_commit_v2('00000000-0000-0000-0000-0000000000d1', p_actor, p_op, 'fp',
    '00000000-0000-0000-0000-00000000000a', true,
    jsonb_build_object('id', gen_random_uuid(), 'category', 'cup_std', 'price_tier', 100, 'name', '标准杯', 'image_paths', to_jsonb(p_paths)),
    '{}', 'n', NULL, p_plan, '2026-10-09-v1'); END $$;
CREATE FUNCTION paths3(p uuid) RETURNS text[] LANGUAGE sql AS $$ SELECT image_paths FROM inv_skus WHERE id=p $$;
-- 旧已发布、无准备记录的标准品
INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price, image_paths)
VALUES ('b3000000-0000-0000-0000-000000000001','cup_std',100,'标准杯','b3-std',false,ARRAY['sku-listing/old/1.png']);
DELETE FROM listing_readiness WHERE sku_id='b3000000-0000-0000-0000-000000000001';
SELECT hold2('b3000000-0000-0000-0000-000000000001');
UPDATE commerce_listings SET image_paths='["sku-listing/old/1.png"]' WHERE sku_id='b3000000-0000-0000-0000-000000000001';

-- R1 新照片：同事务建准备记录 + 本次员工计划 + 入队；公开展示不变
SELECT t2((scR('op-r1','00000000-0000-0000-0000-0000000000e2',ARRAY['sku-raw/std/n1.jpg'],'ai')->>'reused')::boolean, 'R1 standard reuse detected');
SELECT t2(paths3('b3000000-0000-0000-0000-000000000001')=ARRAY['sku-listing/old/1.png','sku-raw/std/n1.jpg'], 'R1 photo appended in commit tx');
SELECT t2((SELECT image_plan='ai' AND image_ai_actor='00000000-0000-0000-0000-0000000000e2' AND image_ai_policy='2026-10-09-v1'
  FROM listing_readiness WHERE sku_id='b3000000-0000-0000-0000-000000000001'), 'R1 legacy sku gets readiness with this uploader plan');
SELECT t2((SELECT count(*)=1 AND bool_and(ai_actor_user_id='00000000-0000-0000-0000-0000000000e2' AND status='queued'
  AND readiness_revision=(SELECT image_input_revision FROM listing_readiness WHERE sku_id='b3000000-0000-0000-0000-000000000001'))
  FROM inv_listing_image_jobs WHERE sku_id='b3000000-0000-0000-0000-000000000001'), 'R1 raw queued for this uploader at current revision');
SELECT t2((listing_readiness_refresh('b3000000-0000-0000-0000-000000000001')->>'image')='running', 'R1 worker-recoverable, not permanently pending');
SELECT t2((SELECT pub_read('b3000000-0000-0000-0000-000000000001')->'image_paths')='["sku-listing/old/1.png"]', 'R1 old public display kept');

-- R2 另一员工新 op：只追加真正新增，换为本次员工；已排队照片不重复
SELECT scR('op-r2','00000000-0000-0000-0000-0000000000e3',ARRAY['sku-raw/std/n1.jpg','sku-raw/std/n2.jpg'],'ai');
SELECT t2(paths3('b3000000-0000-0000-0000-000000000001')=ARRAY['sku-listing/old/1.png','sku-raw/std/n1.jpg','sku-raw/std/n2.jpg'], 'R2 only new photo appended');
SELECT t2((SELECT image_ai_actor='00000000-0000-0000-0000-0000000000e3' FROM listing_readiness WHERE sku_id='b3000000-0000-0000-0000-000000000001')
  AND (SELECT ai_actor_user_id='00000000-0000-0000-0000-0000000000e3' FROM inv_listing_image_jobs WHERE sku_id='b3000000-0000-0000-0000-000000000001' AND source_path='std/n2.jpg')
  AND (SELECT count(*)=2 FROM inv_listing_image_jobs WHERE sku_id='b3000000-0000-0000-0000-000000000001'), 'R2 this uploader persisted, no duplicate jobs');

-- R3 同 op 重试：不追加、不换员工
SELECT scR('op-r2','00000000-0000-0000-0000-0000000000e3',ARRAY['sku-raw/std/n1.jpg','sku-raw/std/n2.jpg'],'ai');
SELECT t2(array_length(paths3('b3000000-0000-0000-0000-000000000001'),1)=3
  AND (SELECT image_ai_actor='00000000-0000-0000-0000-0000000000e3' FROM listing_readiness WHERE sku_id='b3000000-0000-0000-0000-000000000001'), 'R3 same-op replay idempotent');

-- R4 worker 先完成，再来跨 op / 后续请求带同一原图：不复活，已完成照片保留
SELECT handheld_apply_listing_image_result('b3000000-0000-0000-0000-000000000001','sku-raw/std/n1.jpg','sku-listing/std/n1.png');
SELECT handheld_apply_listing_image_result('b3000000-0000-0000-0000-000000000001','sku-raw/std/n2.jpg','sku-listing/std/n2.png');
UPDATE inv_listing_image_jobs SET status='succeeded' WHERE sku_id='b3000000-0000-0000-0000-000000000001';
SELECT t2((scR('op-r4','00000000-0000-0000-0000-0000000000e4',ARRAY['sku-raw/std/n1.jpg','sku-raw/std/n2.jpg'],'ai')->>'photos_appended')::int=0
  AND paths3('b3000000-0000-0000-0000-000000000001')=ARRAY['sku-listing/old/1.png','sku-listing/std/n1.png','sku-listing/std/n2.png']
  AND (SELECT image_ai_actor='00000000-0000-0000-0000-0000000000e3' FROM listing_readiness WHERE sku_id='b3000000-0000-0000-0000-000000000001'),
  'R4 processed raw never resurrected, actor unchanged');
SELECT t2((SELECT count(*)=0 FROM inv_listing_image_jobs WHERE sku_id='b3000000-0000-0000-0000-000000000001' AND status<>'succeeded'), 'R4 no job requeued');
SELECT scR('op-r2','00000000-0000-0000-0000-0000000000e3',ARRAY['sku-raw/std/n1.jpg','sku-raw/std/n2.jpg'],'ai');
SELECT t2(NOT listing_readiness_has_raw(paths3('b3000000-0000-0000-0000-000000000001')), 'R4 late same-op retry after worker keeps processed photos');

-- R5 未确认同意：持久化本次员工，由 worker 补决
SELECT scR('op-r5','00000000-0000-0000-0000-0000000000e5',ARRAY['sku-raw/std/n5.jpg'],'pending_consent');
SELECT t2(EXISTS (SELECT 1 FROM listing_readiness_pending_consent(100) WHERE sku_id='b3000000-0000-0000-0000-000000000001' AND actor='00000000-0000-0000-0000-0000000000e5'),
  'R5 pending consent recoverable by worker with this uploader');
-- R6 明确拒绝 AI：原图可走
SELECT scR('op-r6','00000000-0000-0000-0000-0000000000e6',ARRAY['sku-raw/std/n6.jpg'],'raw_declined');
SELECT t2((SELECT image_plan='raw_declined' AND images_settled FROM listing_readiness WHERE sku_id='b3000000-0000-0000-0000-000000000001'), 'R6 explicit decline settles');
SELECT t2(NOT has_function_privilege('authenticated','listing_readiness_append_reuse_photos(uuid,text[],text,text,uuid,text)','EXECUTE')
  AND NOT has_function_privilege('anon','listing_readiness_append_reuse_photos(uuid,text[],text,text,uuid,text)','EXECUTE'), 'R7 helper service-only');
