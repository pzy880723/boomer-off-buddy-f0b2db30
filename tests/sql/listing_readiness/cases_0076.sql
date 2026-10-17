\set ON_ERROR_STOP 1
-- 0076 纠错回归：无超时后门 / 全入口建记录 / 输入修订 + fencing / 详情图片阻断 / 取消意图 / 自动内容替换与人工保留
CREATE FUNCTION t2(c boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT c THEN RAISE EXCEPTION 'FAIL %', label; END IF; RAISE NOTICE 'PASS %', label; END $$;
CREATE FUNCTION mk2(p_id uuid, p_custom boolean, p_paths text[]) RETURNS void LANGUAGE sql AS $$
  INSERT INTO inv_skus (id, category, price_tier, name, epc, is_custom_price, image_paths)
  VALUES (p_id, 'porcelain', 100, '测试碗', p_id::text, p_custom, p_paths);
$$;
CREATE FUNCTION hold2(p_id uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO inv_stocks (sku_id, location_id, qty) VALUES (p_id, '00000000-0000-0000-0000-00000000000a', 1);
  INSERT INTO commerce_listings (sku_id, location_id, title, price, status, published_at)
  VALUES (p_id, '00000000-0000-0000-0000-00000000000a', '测试碗', 100, 'published', now());
$$;
CREATE FUNCTION blocks2(t text) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_array(jsonb_build_object('id','h','type','heading','text',t)) $$;
CREATE FUNCTION pub2(p_id uuid, t text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT listing_readiness_publish_content(p_id, (SELECT input_revision FROM listing_readiness WHERE sku_id=p_id), blocks2(t), '[]', 'template') $$;
CREATE FUNCTION st2(p_id uuid) RETURNS text LANGUAGE sql AS $$ SELECT status FROM commerce_listings WHERE sku_id=p_id $$;

-- A 超时后门已删除：原图待排队、建于 1 小时前，仍不放行
SELECT mk2('a0000000-0000-0000-0000-000000000001', true, ARRAY['sku-raw/a/1.jpg']);
UPDATE listing_readiness SET created_at = now() - interval '1 hour' WHERE sku_id='a0000000-0000-0000-0000-000000000001';
SELECT hold2('a0000000-0000-0000-0000-000000000001');
SELECT t2((SELECT listing_readiness_refresh('a0000000-0000-0000-0000-000000000001')->>'image')='pending', 'no 10-minute timeout release');
SELECT pub2('a0000000-0000-0000-0000-000000000001', 'x');
SELECT t2(st2('a0000000-0000-0000-0000-000000000001')='hidden', 'unsettled queue stays hidden even with content');
-- A2 已确认排队但原图仍未修（无任务）→ failed，不公开原图
UPDATE listing_readiness SET images_settled=true WHERE sku_id='a0000000-0000-0000-0000-000000000001';
SELECT t2((SELECT listing_readiness_refresh('a0000000-0000-0000-0000-000000000001')->>'image')='failed', 'raw unprocessed image never auto-public');

-- B 所有新 SKU 建记录：标准品、非自定义都建；无原图的 PC 入口同事务即“排队完成”
SELECT mk2('b0000000-0000-0000-0000-000000000001', false, ARRAY['sku-listing/gallery/b/1.png']);
SELECT t2((SELECT images_settled FROM listing_readiness WHERE sku_id='b0000000-0000-0000-0000-000000000001'), 'standard/PC sku gets readiness, settled in same tx');
SELECT mk2('a0000000-0000-0000-0000-000000000002', true, ARRAY['sku-raw/a/2.jpg']);
SELECT t2((SELECT NOT images_settled FROM listing_readiness WHERE sku_id='a0000000-0000-0000-0000-000000000002'), 'raw-photo sku waits for queue confirmation');
SELECT hold2('b0000000-0000-0000-0000-000000000001');
SELECT t2(st2('b0000000-0000-0000-0000-000000000001')='hidden', 'standard sku publish intent gated');
SELECT listing_readiness_refresh('b0000000-0000-0000-0000-000000000001');
SELECT t2((pub2('b0000000-0000-0000-0000-000000000001','标准')->>'released')::int=1 AND st2('b0000000-0000-0000-0000-000000000001')='published', 'standard sku released when ready');

-- C 输入修订：改名 bump；旧修订详情回调 stale；自动内容原子替换；已公开版本在重生成期间保持可见
SELECT t2((SELECT input_revision FROM listing_readiness WHERE sku_id='b0000000-0000-0000-0000-000000000001')=1, 'rev 1 before edit');
UPDATE inv_skus SET name='标准改名' WHERE id='b0000000-0000-0000-0000-000000000001';
SELECT t2((SELECT input_revision=2 AND content_status='pending' FROM listing_readiness WHERE sku_id='b0000000-0000-0000-0000-000000000001'), 'fact edit bumps revision and resets content');
SELECT t2(st2('b0000000-0000-0000-0000-000000000001')='published', 'old complete version stays public during regeneration');
SELECT t2((SELECT listing_readiness_publish_content('b0000000-0000-0000-0000-000000000001', 1, blocks2('旧'), '[]', 'template')->>'status')='stale', 'old-revision content callback stale');
SELECT listing_readiness_refresh('b0000000-0000-0000-0000-000000000001');
SELECT t2((pub2('b0000000-0000-0000-0000-000000000001','标准改名')->>'status')='template_replaced', 'auto content replaced for new revision');
SELECT t2((SELECT published_blocks->0->>'text'='标准改名' AND version=2 FROM inv_product_content WHERE sku_id='b0000000-0000-0000-0000-000000000001'), 'replacement atomic, version advanced');
-- C2 人工编辑后再修订：保留人工内容，绑定新修订
UPDATE inv_product_content SET published_blocks=blocks2('人工'), version=version+1, published_version=version+1 WHERE sku_id='b0000000-0000-0000-0000-000000000001';
UPDATE inv_skus SET grade='A' WHERE id='b0000000-0000-0000-0000-000000000001';
SELECT listing_readiness_refresh('b0000000-0000-0000-0000-000000000001');
SELECT t2((pub2('b0000000-0000-0000-0000-000000000001','自动')->>'status')='reused_existing', 'manual content kept on new revision');
SELECT t2((SELECT published_blocks->0->>'text'='人工' FROM inv_product_content WHERE sku_id='b0000000-0000-0000-0000-000000000001')
  AND (SELECT content_revision=input_revision FROM listing_readiness WHERE sku_id='b0000000-0000-0000-0000-000000000001'), 'manual content bound to current revision');
-- C3 facets 变化也 bump
INSERT INTO inv_sku_facets VALUES ('b0000000-0000-0000-0000-000000000001', gen_random_uuid());
SELECT t2((SELECT input_revision=4 FROM listing_readiness WHERE sku_id='b0000000-0000-0000-0000-000000000001'), 'facet change bumps revision');

-- D 照片修订 + 回调 fencing：旧任务完成不改新 SKU 图片
SELECT mk2('d0000000-0000-0000-0000-000000000001', true, ARRAY['sku-raw/d/1.jpg']);
INSERT INTO inv_listing_image_jobs (id, sku_id, source_bucket, source_path, status, readiness_revision, claim_token, lease_until, ai_actor_user_id, ai_policy_version)
VALUES ('d0000000-0000-0000-0000-000000000011','d0000000-0000-0000-0000-000000000001','sku-raw','d/1.jpg','processing',1,
        'd0000000-0000-0000-0000-000000000021', now()+interval '5 minutes','d0000000-0000-0000-0000-0000000000aa','v1');
SELECT listing_readiness_mark_images_settled('d0000000-0000-0000-0000-000000000001');
UPDATE inv_skus SET image_paths=ARRAY['sku-raw/d/1.jpg','sku-raw/d/2.jpg'] WHERE id='d0000000-0000-0000-0000-000000000001';
SELECT t2((SELECT input_revision=2 AND image_input_revision=2 AND images_settled FROM listing_readiness WHERE sku_id='d0000000-0000-0000-0000-000000000001'), 'photo edit bumps image revision and re-queues in same tx');
SELECT t2((SELECT count(*)=2 AND bool_and(status='queued' AND readiness_revision=2 AND claim_token IS NULL AND ai_actor_user_id='d0000000-0000-0000-0000-0000000000aa')
  FROM inv_listing_image_jobs WHERE sku_id='d0000000-0000-0000-0000-000000000001'), 'requeued with original consent actor, old token revoked');
INSERT INTO storage.objects VALUES ('sku-listing','gallery/d0000000-0000-0000-0000-000000000001/d0000000-0000-0000-0000-000000000011/d0000000-0000-0000-0000-000000000021.png');
SELECT t2(handheld_listing_image_finish('d0000000-0000-0000-0000-000000000011','d0000000-0000-0000-0000-000000000021',
  'sku-listing/gallery/d0000000-0000-0000-0000-000000000001/d0000000-0000-0000-0000-000000000011/d0000000-0000-0000-0000-000000000021.png', NULL)='stale', 'old worker token fenced');
SELECT t2((SELECT image_paths=ARRAY['sku-raw/d/1.jpg','sku-raw/d/2.jpg'] FROM inv_skus WHERE id='d0000000-0000-0000-0000-000000000001'), 'old job did not modify sku images');
-- D2 旧修订任务即使持有有效令牌也被拒（不同 source 场景）
INSERT INTO inv_listing_image_jobs (id, sku_id, source_bucket, source_path, status, readiness_revision, claim_token, lease_until)
VALUES ('d0000000-0000-0000-0000-000000000013','d0000000-0000-0000-0000-000000000001','sku-raw','d/old.jpg','processing',1,
        'd0000000-0000-0000-0000-000000000023', now()+interval '5 minutes');
SELECT t2(handheld_listing_image_finish('d0000000-0000-0000-0000-000000000013','d0000000-0000-0000-0000-000000000023','sku-listing/x.png', NULL)='permanent_failed'
  AND (SELECT last_error='stale_input_revision' FROM inv_listing_image_jobs WHERE id='d0000000-0000-0000-0000-000000000013'), 'old-revision job with valid token rejected');
DELETE FROM inv_listing_image_jobs WHERE id='d0000000-0000-0000-0000-000000000013';
-- D3 当前修订任务完成：应用结果不再 bump 修订
UPDATE inv_listing_image_jobs SET status='processing', claim_token='d0000000-0000-0000-0000-000000000022', lease_until=now()+interval '5 minutes'
 WHERE sku_id='d0000000-0000-0000-0000-000000000001' AND source_path='d/1.jpg';
INSERT INTO storage.objects VALUES ('sku-listing','gallery/d0000000-0000-0000-0000-000000000001/d0000000-0000-0000-0000-000000000011/d0000000-0000-0000-0000-000000000022.png');
SELECT t2(handheld_listing_image_finish('d0000000-0000-0000-0000-000000000011','d0000000-0000-0000-0000-000000000022',
  'sku-listing/gallery/d0000000-0000-0000-0000-000000000001/d0000000-0000-0000-0000-000000000011/d0000000-0000-0000-0000-000000000022.png', NULL)='succeeded', 'current-revision job applies');
SELECT t2((SELECT input_revision=2 FROM listing_readiness WHERE sku_id='d0000000-0000-0000-0000-000000000001'), 'applying processed image does not bump revision');
SELECT t2((SELECT listing_readiness_refresh('d0000000-0000-0000-0000-000000000001')->>'image')='running', 'second job still open blocks');

-- E 详情图片任务阻断
SELECT mk2('e0000000-0000-0000-0000-000000000001', true, ARRAY['sku-listing/e/1.png']);
SELECT hold2('e0000000-0000-0000-0000-000000000001');
INSERT INTO inv_product_content_image_jobs (sku_id, block_id, source_path, status) VALUES ('e0000000-0000-0000-0000-000000000001','b1','sku-raw/e/x.jpg','processing');
SELECT listing_readiness_refresh('e0000000-0000-0000-0000-000000000001');
SELECT pub2('e0000000-0000-0000-0000-000000000001','e');
SELECT t2(st2('e0000000-0000-0000-0000-000000000001')='hidden', 'running detail image job blocks release');
UPDATE inv_product_content_image_jobs SET status='permanent_failed' WHERE sku_id='e0000000-0000-0000-0000-000000000001';
SELECT t2((SELECT listing_readiness_refresh('e0000000-0000-0000-0000-000000000001')->>'detail_images')='failed' AND st2('e0000000-0000-0000-0000-000000000001')='hidden', 'failed detail image blocks');
SELECT t2((SELECT (listing_readiness_retry('e0000000-0000-0000-0000-000000000001')->>'requeued_detail_images')::int)=1, 'retry requeues detail image');
UPDATE inv_product_content_image_jobs SET status='succeeded' WHERE sku_id='e0000000-0000-0000-0000-000000000001';
SELECT t2((SELECT (listing_readiness_refresh('e0000000-0000-0000-0000-000000000001')->>'released')::int)=1, 'detail images done releases');

-- F 显式下架取消意图：完成后不再自动上架
SELECT mk2('f0000000-0000-0000-0000-000000000001', true, ARRAY['sku-listing/f/1.png']);
SELECT hold2('f0000000-0000-0000-0000-000000000001');
UPDATE commerce_listings SET status='hidden', readiness_hold=false WHERE sku_id='f0000000-0000-0000-0000-000000000001';
SELECT listing_readiness_refresh('f0000000-0000-0000-0000-000000000001');
SELECT pub2('f0000000-0000-0000-0000-000000000001','f');
SELECT t2(st2('f0000000-0000-0000-0000-000000000001')='hidden' AND (SELECT published_at IS NULL FROM commerce_listings WHERE sku_id='f0000000-0000-0000-0000-000000000001'), 'manual take-down cancels hold');
SELECT mk2('f0000000-0000-0000-0000-000000000002', true, ARRAY['sku-listing/f/2.png']);
SELECT hold2('f0000000-0000-0000-0000-000000000002');
UPDATE commerce_listings SET status='archived' WHERE sku_id='f0000000-0000-0000-0000-000000000002';
SELECT t2((SELECT NOT readiness_hold AND published_at IS NULL FROM commerce_listings WHERE sku_id='f0000000-0000-0000-0000-000000000002'), 'archive cancels hold, never public');
SELECT t2((SELECT readiness_hold FROM commerce_listings WHERE sku_id='e0000000-0000-0000-0000-000000000001') IS FALSE, 'released listing hold cleared');
-- F2 SKU 编辑同步 listing 标题不会误取消意图
SELECT mk2('f0000000-0000-0000-0000-000000000003', true, ARRAY['sku-listing/f/3.png']);
SELECT hold2('f0000000-0000-0000-0000-000000000003');
UPDATE commerce_listings SET title='新标题' WHERE sku_id='f0000000-0000-0000-0000-000000000003';
SELECT t2((SELECT readiness_hold FROM commerce_listings WHERE sku_id='f0000000-0000-0000-0000-000000000003'), 'title sync keeps intent');

-- G 旧商品不受影响（无记录 = legacy，编辑不建记录）
INSERT INTO inv_skus (id, category, price_tier, name, epc) VALUES ('90000000-0000-0000-0000-000000000009','c',1,'旧品','e9');
DELETE FROM listing_readiness WHERE sku_id='90000000-0000-0000-0000-000000000009';
UPDATE inv_skus SET name='旧品改名', image_paths=ARRAY['sku-raw/z.jpg'] WHERE id='90000000-0000-0000-0000-000000000009';
SELECT t2((SELECT count(*)=0 FROM listing_readiness WHERE sku_id='90000000-0000-0000-0000-000000000009')
  AND (SELECT count(*)=0 FROM inv_listing_image_jobs WHERE sku_id='90000000-0000-0000-0000-000000000009'), 'legacy sku edit untouched, no AI queued');
SELECT t2(NOT has_function_privilege('authenticated','listing_readiness_bump(uuid,boolean,text[])','EXECUTE')
  AND NOT has_function_privilege('anon','handheld_listing_image_finish(uuid,uuid,text,text)','EXECUTE'), 'new functions service-only');
