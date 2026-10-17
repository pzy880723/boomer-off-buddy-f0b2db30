\set ON_ERROR_STOP 1
-- 0080 回归：未确认原图不得被编辑隐式确认；建品原事务持久化计划并入队；授权补决幂等；已发布展示隔离（读取实际公开字段）。
CREATE FUNCTION sc3(p_id uuid, p_op text, p_paths text[], p_plan text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN RETURN handheld_smart_create_commit_v2('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1',
    p_op, 'fp', '00000000-0000-0000-0000-00000000000a', false,
    jsonb_build_object('id', p_id, 'category', 'porcelain_jp', 'name', '建品', 'image_paths', to_jsonb(p_paths)),
    '{}', 'n', NULL, p_plan, '2026-10-09-v1'); END $$;
CREATE FUNCTION open3(p_id uuid) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM inv_listing_image_jobs WHERE sku_id = p_id AND status IN ('queued','processing','retryable_failed') $$;
CREATE FUNCTION pub_read(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
  -- 与 storefront 列表/详情相同的公开字段
  SELECT jsonb_build_object('image_paths', image_paths, 'cover_url', cover_url, 'image_urls', image_urls)
    FROM commerce_listings WHERE sku_id = p_id AND status = 'published' $$;

-- P1 Codex 反例：mk2 原图、无任务 → 编辑新原图不得隐式确认
SELECT mk2('a8000000-0000-0000-0000-000000000001', true, ARRAY['sku-raw/p1/1.jpg']);
SELECT t2(NOT (SELECT images_settled FROM listing_readiness WHERE sku_id='a8000000-0000-0000-0000-000000000001'), 'P1 raw sku initially unsettled');
UPDATE inv_skus SET image_paths=ARRAY['sku-raw/p1/1.jpg','sku-raw/p1/2.jpg'] WHERE id='a8000000-0000-0000-0000-000000000001';
SELECT t2(NOT (SELECT images_settled FROM listing_readiness WHERE sku_id='a8000000-0000-0000-0000-000000000001')
  AND open3('a8000000-0000-0000-0000-000000000001')=0, 'P1 raw edit without actor/plan stays unsettled, no AI queued');
SELECT t2((SELECT listing_readiness_refresh('a8000000-0000-0000-0000-000000000001')->>'image')='pending', 'P1 refresh keeps image pending');
SELECT hold2('a8000000-0000-0000-0000-000000000001'); SELECT pub2('a8000000-0000-0000-0000-000000000001','x');
SELECT t2(st2('a8000000-0000-0000-0000-000000000001')='hidden', 'P1 never published with raw photos');

-- P2 建品原事务：ai 计划 + 可信 actor 同事务入队；之后路由“崩溃”也无需店员再编辑
SELECT sc3('a8000000-0000-0000-0000-000000000002', 'op-ai', ARRAY['sku-raw/p2/1.jpg','sku-raw/p2/2.jpg'], 'ai');
SELECT t2((SELECT image_plan='ai' AND image_ai_actor='00000000-0000-0000-0000-0000000000e1' AND image_ai_policy='2026-10-09-v1' AND images_settled
  FROM listing_readiness WHERE sku_id='a8000000-0000-0000-0000-000000000002'), 'P2 plan + actor persisted in commit tx');
SELECT t2(open3('a8000000-0000-0000-0000-000000000002')=2 AND (SELECT bool_and(ai_actor_user_id='00000000-0000-0000-0000-0000000000e1' AND readiness_revision=1)
  FROM inv_listing_image_jobs WHERE sku_id='a8000000-0000-0000-0000-000000000002'), 'P2 jobs queued in same tx with original actor');
SELECT t2((SELECT listing_readiness_refresh('a8000000-0000-0000-0000-000000000002')->>'image')='running', 'P2 worker-recoverable: running without client retry');
-- P2b 同 op 回放不重复入队
SELECT t2((sc3('a8000000-0000-0000-0000-000000000002', 'op-ai', ARRAY['sku-raw/p2/1.jpg','sku-raw/p2/2.jpg'], 'ai')->>'image_jobs_open')::int=2
  AND (SELECT count(*)=2 FROM inv_listing_image_jobs WHERE sku_id='a8000000-0000-0000-0000-000000000002'), 'P2b replay does not duplicate jobs');
-- P2c 原子性：建品事务回滚时计划与任务一起消失
DO $$ BEGIN
  PERFORM sc3('a8000000-0000-0000-0000-000000000009', 'op-rb', ARRAY['sku-raw/rb/1.jpg'], 'ai');
  RAISE EXCEPTION 'rollback';
EXCEPTION WHEN raise_exception THEN NULL; END $$;
SELECT t2((SELECT count(*)=0 FROM inv_listing_image_jobs WHERE sku_id='a8000000-0000-0000-0000-000000000009')
  AND (SELECT count(*)=0 FROM listing_readiness WHERE sku_id='a8000000-0000-0000-0000-000000000009'), 'P2c plan/jobs atomic with sku commit');
-- P2d 非法计划被拒
DO $$ BEGIN
  PERFORM sc3('a8000000-0000-0000-0000-000000000008', 'op-bad', ARRAY['sku-raw/b/1.jpg'], 'auto');
  RAISE EXCEPTION 'FAIL P2d accepted';
EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'PASS P2d invalid plan rejected'; END $$;

-- P3 明确不做 AI：原图可用
SELECT sc3('a8000000-0000-0000-0000-000000000003', 'op-raw', ARRAY['sku-raw/p3/1.jpg'], 'raw_declined');
SELECT t2((SELECT image_plan='raw_declined' AND images_settled FROM listing_readiness WHERE sku_id='a8000000-0000-0000-0000-000000000003')
  AND open3('a8000000-0000-0000-0000-000000000003')=0, 'P3 explicit decline settles raw without AI');
SELECT t2((SELECT listing_readiness_refresh('a8000000-0000-0000-0000-000000000003')->>'image')='succeeded', 'P3 raw photos accepted only after explicit decline');
UPDATE inv_skus SET image_paths=ARRAY['sku-raw/p3/1.jpg','sku-raw/p3/2.jpg'] WHERE id='a8000000-0000-0000-0000-000000000003';
SELECT t2((SELECT images_settled FROM listing_readiness WHERE sku_id='a8000000-0000-0000-0000-000000000003')
  AND open3('a8000000-0000-0000-0000-000000000003')=0, 'P3b later raw edit keeps explicit decline, no AI');

-- P4 授权未明确：不排队、不放行；sweep 只接受原 actor，幂等补决
SELECT sc3('a8000000-0000-0000-0000-000000000004', 'op-pc', ARRAY['sku-raw/p4/1.jpg'], 'pending_consent');
SELECT t2((SELECT image_plan='pending_consent' AND NOT images_settled FROM listing_readiness WHERE sku_id='a8000000-0000-0000-0000-000000000004')
  AND open3('a8000000-0000-0000-0000-000000000004')=0, 'P4 unknown consent: no AI, not settled');
SELECT t2(EXISTS (SELECT 1 FROM listing_readiness_pending_consent(20) WHERE sku_id='a8000000-0000-0000-0000-000000000004'
  AND actor='00000000-0000-0000-0000-0000000000e1'), 'P4 sweep lists pending plan with persisted actor');
SELECT t2((listing_readiness_resolve_consent('a8000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000ff','ai','2026-10-09-v1')->>'status')='noop'
  AND open3('a8000000-0000-0000-0000-000000000004')=0, 'P4 other actor cannot resolve');
SELECT listing_readiness_resolve_consent('a8000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000e1','ai','2026-10-09-v1');
SELECT t2(open3('a8000000-0000-0000-0000-000000000004')=1 AND (SELECT image_plan='ai' AND images_settled FROM listing_readiness WHERE sku_id='a8000000-0000-0000-0000-000000000004'),
  'P4 consent later granted: queued via sweep, no staff re-edit');
SELECT t2((listing_readiness_resolve_consent('a8000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000e1','ai','2026-10-09-v1')->>'status')='noop'
  AND (SELECT count(*)=1 FROM inv_listing_image_jobs WHERE sku_id='a8000000-0000-0000-0000-000000000004'), 'P4 resolve idempotent');
SELECT sc3('a8000000-0000-0000-0000-000000000005', 'op-pc2', ARRAY['sku-raw/p5/1.jpg'], 'pending_consent');
SELECT listing_readiness_resolve_consent('a8000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-0000000000e1','raw_declined','2026-10-09-v1');
SELECT t2((SELECT image_plan='raw_declined' AND images_settled FROM listing_readiness WHERE sku_id='a8000000-0000-0000-0000-000000000005')
  AND open3('a8000000-0000-0000-0000-000000000005')=0, 'P5 explicit refusal resolves to original photos');

-- P6 ai 计划、建品时无原图，后续编辑加原图 → 用持久化 actor 入队（不依赖历史任务）
SELECT sc3('a8000000-0000-0000-0000-000000000006', 'op-ai2', ARRAY['sku-listing/p6/1.png'], 'ai');
UPDATE inv_skus SET image_paths=ARRAY['sku-listing/p6/1.png','sku-raw/p6/2.jpg'] WHERE id='a8000000-0000-0000-0000-000000000006';
SELECT t2(open3('a8000000-0000-0000-0000-000000000006')=1 AND (SELECT ai_actor_user_id='00000000-0000-0000-0000-0000000000e1' AND readiness_revision=2
  FROM inv_listing_image_jobs WHERE sku_id='a8000000-0000-0000-0000-000000000006'), 'P6 later raw edit queued with persisted actor');

-- P7 已发布商品重新处理：公开读取保持旧完整展示，直到新修订全部就绪才原子替换
SELECT mk2('a8000000-0000-0000-0000-000000000007', true, ARRAY['sku-listing/g/1.png']);
SELECT hold2('a8000000-0000-0000-0000-000000000007');
UPDATE commerce_listings SET image_paths='["sku-listing/g/1.png"]', cover_url='old-cover', image_urls='["old-url"]'
 WHERE sku_id='a8000000-0000-0000-0000-000000000007';
SELECT listing_readiness_refresh('a8000000-0000-0000-0000-000000000007'); SELECT pub2('a8000000-0000-0000-0000-000000000007','旧');
SELECT t2(st2('a8000000-0000-0000-0000-000000000007')='published' AND pub_read('a8000000-0000-0000-0000-000000000007')->'image_paths'='["sku-listing/g/1.png"]',
  'P7 baseline published with finished images');
SELECT listing_readiness_apply_image_plan('a8000000-0000-0000-0000-000000000007','ai','00000000-0000-0000-0000-0000000000e1','2026-10-09-v1');
UPDATE inv_skus SET image_paths=ARRAY['sku-listing/g/1.png','sku-raw/g/2.jpg'] WHERE id='a8000000-0000-0000-0000-000000000007';
UPDATE commerce_listings SET image_paths='["sku-listing/g/1.png","sku-raw/g/2.jpg"]', cover_url='raw-cover', image_urls='["raw-url"]'
 WHERE sku_id='a8000000-0000-0000-0000-000000000007';
SELECT t2(pub_read('a8000000-0000-0000-0000-000000000007') = '{"image_paths":["sku-listing/g/1.png"],"cover_url":"old-cover","image_urls":["old-url"]}'::jsonb,
  'P7 public read keeps old complete display while raw re-processing');
SELECT t2((SELECT pending_display->'image_paths'='["sku-listing/g/1.png","sku-raw/g/2.jpg"]' FROM commerce_listings WHERE sku_id='a8000000-0000-0000-0000-000000000007'),
  'P7 new images parked in pending_display');
SELECT set_config('boomer.listing_image_apply','1',false);
SELECT handheld_apply_listing_image_result('a8000000-0000-0000-0000-000000000007','sku-raw/g/2.jpg','sku-listing/g/2.png');
SELECT set_config('boomer.listing_image_apply','',false);
SELECT t2(pub_read('a8000000-0000-0000-0000-000000000007')->'image_paths'='["sku-listing/g/1.png"]'
  AND (SELECT pending_display->'image_paths'='["sku-listing/g/1.png","sku-listing/g/2.png"]' FROM commerce_listings WHERE sku_id='a8000000-0000-0000-0000-000000000007'),
  'P7 half-finished processing applied to pending only, public unchanged');
UPDATE inv_listing_image_jobs SET status='succeeded' WHERE sku_id='a8000000-0000-0000-0000-000000000007';
SELECT listing_readiness_refresh('a8000000-0000-0000-0000-000000000007'); SELECT pub2('a8000000-0000-0000-0000-000000000007','新');
SELECT t2(pub_read('a8000000-0000-0000-0000-000000000007')->'image_paths'='["sku-listing/g/1.png","sku-listing/g/2.png"]'
  AND (SELECT pending_display IS NULL FROM commerce_listings WHERE sku_id='a8000000-0000-0000-0000-000000000007')
  AND st2('a8000000-0000-0000-0000-000000000007')='published', 'P7 swapped atomically to new complete display when ready');

-- P8 旧的已发布商品（无准备记录）换入原图：建立门禁，旧展示继续可见
INSERT INTO inv_skus (id, category, price_tier, name, epc, image_paths) VALUES ('98000000-0000-0000-0000-000000000008','c',1,'旧品','e98',ARRAY['sku-listing/old/1.png']);
DELETE FROM listing_readiness WHERE sku_id='98000000-0000-0000-0000-000000000008';
INSERT INTO inv_stocks (sku_id, location_id, qty) VALUES ('98000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-00000000000a',1);
INSERT INTO commerce_listings (sku_id, location_id, title, price, status, published_at, image_paths)
VALUES ('98000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-00000000000a','旧品',1,'published',now(),'["sku-listing/old/1.png"]');
UPDATE inv_skus SET image_paths=ARRAY['sku-raw/old/2.jpg'] WHERE id='98000000-0000-0000-0000-000000000008';
UPDATE commerce_listings SET image_paths='["sku-raw/old/2.jpg"]' WHERE sku_id='98000000-0000-0000-0000-000000000008';
SELECT t2((SELECT NOT images_settled AND image_plan IS NULL FROM listing_readiness WHERE sku_id='98000000-0000-0000-0000-000000000008')
  AND pub_read('98000000-0000-0000-0000-000000000008')->'image_paths'='["sku-listing/old/1.png"]'
  AND open3('98000000-0000-0000-0000-000000000008')=0, 'P8 legacy published item keeps old display, raw gated, no AI');

-- P9 非公开 listing 的图片字段照常更新（不误暂存）
SELECT mk2('a8000000-0000-0000-0000-00000000000a', true, ARRAY['sku-raw/h/1.jpg']);
SELECT hold2('a8000000-0000-0000-0000-00000000000a');
UPDATE commerce_listings SET image_paths='["sku-raw/h/9.jpg"]' WHERE sku_id='a8000000-0000-0000-0000-00000000000a';
SELECT t2((SELECT image_paths='["sku-raw/h/9.jpg"]' AND pending_display IS NULL FROM commerce_listings WHERE sku_id='a8000000-0000-0000-0000-00000000000a'),
  'P9 hidden listing updates directly');

-- P10 权限：新函数 service-only
SELECT t2(NOT has_function_privilege('authenticated','handheld_smart_create_commit_v2(uuid,uuid,text,text,uuid,boolean,jsonb,text[],text,uuid,text,text)','EXECUTE')
  AND NOT has_function_privilege('anon','listing_readiness_resolve_consent(uuid,uuid,text,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','listing_readiness_apply_image_plan(uuid,text,uuid,text)','EXECUTE')
  AND NOT has_function_privilege('anon','listing_readiness_pending_consent(integer)','EXECUTE')
  AND has_function_privilege('service_role','handheld_smart_create_commit_v2(uuid,uuid,text,text,uuid,boolean,jsonb,text[],text,uuid,text,text)','EXECUTE'),
  'P10 new functions service-only');
