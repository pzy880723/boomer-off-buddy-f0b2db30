\set ON_ERROR_STOP 1
-- 两个 SKU：A 6 张（较早上架），B 1 张；A 已有 1 张成功
INSERT INTO inv_skus(id,image_paths) VALUES
 ('a0000000-0000-4000-8000-000000000001', ARRAY['sku-listing/done0.png','sku-raw/a1','sku-raw/a2','sku-raw/a3','sku-raw/a4','sku-raw/a5']),
 ('b0000000-0000-4000-8000-000000000001', ARRAY['sku-raw/b0']);
INSERT INTO inv_listing_image_jobs(sku_id,source_bucket,source_path,source_index,status,created_at,completed_at,attempts) VALUES
 ('a0000000-0000-4000-8000-000000000001','sku-raw','a0',0,'succeeded',now()-interval '3 min',now(),1);
INSERT INTO inv_listing_image_jobs(sku_id,source_bucket,source_path,source_index,created_at)
 SELECT 'a0000000-0000-4000-8000-000000000001','sku-raw','a'||i,i,now()-interval '3 min'+(6-i)*interval '1 second' FROM generate_series(1,5) i;
INSERT INTO inv_listing_image_jobs(sku_id,source_bucket,source_path,source_index,created_at) VALUES ('b0000000-0000-4000-8000-000000000001','sku-raw','b0',0,now()-interval '1 min');
INSERT INTO inv_product_content_image_jobs(sku_id,block_id,source_path) VALUES ('a0000000-0000-4000-8000-000000000001','blk','x');
INSERT INTO inv_product_content(sku_id,draft_blocks,published_blocks) VALUES ('a0000000-0000-4000-8000-000000000001','[]','[{"type":"image","id":"blk","storage_path":"x"}]');

DO $$ DECLARE r record; v_ids text[]; n int; BEGIN
  -- S1 重复重修：同源 upsert 不堆任务
  INSERT INTO inv_listing_image_jobs(sku_id,source_bucket,source_path) VALUES ('a0000000-0000-4000-8000-000000000001','sku-raw','a1') ON CONFLICT DO NOTHING;
  INSERT INTO inv_listing_image_jobs(sku_id,source_bucket,source_path) VALUES ('a0000000-0000-4000-8000-000000000001','sku-raw','a0') ON CONFLICT DO NOTHING;
  ASSERT (SELECT count(*) FROM inv_listing_image_jobs WHERE sku_id='a0000000-0000-4000-8000-000000000001')=6, 'S1 dup';
  ASSERT (SELECT status FROM inv_listing_image_jobs WHERE source_path='a0')='succeeded', 'S1 succeeded not reset';
  RAISE NOTICE 'PASS S1 manual re-repair does not stack jobs; succeeded photo untouched';
  -- S2 图库优先：详情图不认领
  ASSERT (SELECT count(*) FROM product_content_image_claim(6))=0, 'S2 content must yield';
  RAISE NOTICE 'PASS S2 gallery before detail images';
  -- S3 主图/同组优先：limit 6 → A 的 5 张按 source_index + B
  SELECT array_agg(source_path ORDER BY source_index, source_path) INTO v_ids FROM handheld_listing_image_claim(6);
  ASSERT v_ids = ARRAY['b0','a1','a2','a3','a4','a5'] OR (SELECT count(*) FROM inv_listing_image_jobs WHERE status='processing')=6, 'S3 '||v_ids::text;
  ASSERT (SELECT bool_and(lease_until<=now()+interval '4 minutes' AND lease_until>now()+interval '3 minutes') FROM inv_listing_image_jobs WHERE status='processing'), 'S3 lease 4min';
  ASSERT NOT EXISTS (SELECT 1 FROM inv_listing_image_jobs WHERE source_path='a0' AND status<>'succeeded'), 'S3 succeeded re-run';
  RAISE NOTICE 'PASS S3 single+6-image group claimed together, lease 4min, succeeded not re-run';
END $$;
-- S3b 小 limit 时按组顺序：先 A（较早）主图序
BEGIN;
  UPDATE inv_listing_image_jobs SET status='queued',claim_token=NULL,lease_until=NULL,attempts=0 WHERE status='processing';
  DO $$ DECLARE v text[]; BEGIN
    SELECT array_agg(source_path ORDER BY source_index) INTO v FROM handheld_listing_image_claim(2);
    ASSERT v = ARRAY['a1','a2'], 'S3b order '||v::text;
    RAISE NOTICE 'PASS S3b earliest SKU group first, by source_index';
  END $$;
ROLLBACK;
DO $$ DECLARE j record; s text; BEGIN
  -- S4 失败短重试：10s，不等 30min
  SELECT * INTO j FROM inv_listing_image_jobs WHERE source_path='a1';
  s := handheld_listing_image_finish(j.id, j.claim_token, NULL, '[image_generation] TimeoutError: timeout');
  ASSERT s='retryable_failed', 'S4 '||s;
  SELECT * INTO j FROM inv_listing_image_jobs WHERE source_path='a1';
  ASSERT j.next_run_at <= now()+interval '10 seconds' AND j.next_run_at > now(), 'S4 backoff';
  RAISE NOTICE 'PASS S4 transient failure retries after 10s';
  -- S5 永久错误立即失败
  SELECT * INTO j FROM inv_listing_image_jobs WHERE source_path='a2';
  ASSERT handheld_listing_image_finish(j.id, j.claim_token, NULL, 'permanent: unsupported image')='permanent_failed', 'S5a';
  SELECT * INTO j FROM inv_listing_image_jobs WHERE source_path='a3';
  ASSERT handheld_listing_image_finish(j.id, j.claim_token, NULL, 'ai_consent_missing: x')='permanent_failed', 'S5b';
  ASSERT (SELECT image_paths[3] FROM inv_skus WHERE id='a0000000-0000-4000-8000-000000000001')='sku-raw/a2', 'S5 original stays, not succeeded';
  RAISE NOTICE 'PASS S5 permanent errors fail at once, original not reported as success';
  -- S6 stale claim 不得覆盖：员工删除了 a4 源图后完成
  SELECT * INTO j FROM inv_listing_image_jobs WHERE source_path='a4';
  ASSERT handheld_listing_image_finish(j.id, gen_random_uuid(), 'sku-listing/x.png', NULL)='stale', 'S6 wrong token';
  UPDATE inv_skus SET image_paths=array_remove(image_paths,'sku-raw/a4') WHERE id='a0000000-0000-4000-8000-000000000001';
  INSERT INTO storage.objects VALUES ('sku-listing','gallery/a0000000-0000-4000-8000-000000000001/'||j.id||'/'||j.claim_token||'.png');
  ASSERT handheld_listing_image_finish(j.id, j.claim_token, 'sku-listing/gallery/a0000000-0000-4000-8000-000000000001/'||j.id||'/'||j.claim_token||'.png', NULL)='permanent_failed', 'S6 edited';
  ASSERT NOT ('sku-listing/gallery/a0000000-0000-4000-8000-000000000001/'||j.id||'/'||j.claim_token||'.png' = ANY((SELECT image_paths FROM inv_skus WHERE id='a0000000-0000-4000-8000-000000000001'))), 'S6 overwrote';
  RAISE NOTICE 'PASS S6 stale token rejected; staff edit not overwritten';
  -- S7 成功应用→image_paths 更新（触发商城/有赞同步的同一列）
  SELECT * INTO j FROM inv_listing_image_jobs WHERE source_path='a5';
  INSERT INTO storage.objects VALUES ('sku-listing','gallery/a0000000-0000-4000-8000-000000000001/'||j.id||'/'||j.claim_token||'.png');
  ASSERT handheld_listing_image_finish(j.id, j.claim_token, 'sku-listing/gallery/a0000000-0000-4000-8000-000000000001/'||j.id||'/'||j.claim_token||'.png', NULL)='succeeded', 'S7';
  ASSERT (SELECT refresh_count FROM inv_skus WHERE id='a0000000-0000-4000-8000-000000000001')=1, 'S7 apply once';
  RAISE NOTICE 'PASS S7 success applies once to this SKU image_paths';
END $$;
DO $$ DECLARE j record; i int; s text; BEGIN
  -- S8 次数上限：第 5 次失败为 permanent，第 6 次不再认领；退避不超过 60s
  UPDATE inv_listing_image_jobs SET status='retryable_failed', next_run_at=now()-interval '1s' WHERE source_path='b0';
  FOR i IN 1..5 LOOP
    UPDATE inv_listing_image_jobs SET next_run_at=now()-interval '1s' WHERE source_path='b0' AND status='retryable_failed';
    PERFORM handheld_listing_image_claim(6);
    SELECT * INTO j FROM inv_listing_image_jobs WHERE source_path='b0';
    EXIT WHEN j.status<>'processing';
    s := handheld_listing_image_finish(j.id, j.claim_token, NULL, '[measurement_detection] 429');
    SELECT * INTO j FROM inv_listing_image_jobs WHERE source_path='b0';
    ASSERT j.status='permanent_failed' OR j.next_run_at<=now()+interval '60 seconds', 'S8 backoff cap';
  END LOOP;
  ASSERT (SELECT status FROM inv_listing_image_jobs WHERE source_path='b0')='permanent_failed', 'S8 limit';
  ASSERT (SELECT attempts FROM inv_listing_image_jobs WHERE source_path='b0')<=5, 'S8 attempts';
  RAISE NOTICE 'PASS S8 attempt limit 5, backoff ≤60s';
  -- S9 过期 lease 回收（4 分钟）
  UPDATE inv_listing_image_jobs SET status='processing', attempts=1, lease_until=now()-interval '1s', next_run_at=now() WHERE source_path='a1';
  ASSERT EXISTS (SELECT 1 FROM handheld_listing_image_claim(6) WHERE source_path='a1'), 'S9 reclaim';
  RAISE NOTICE 'PASS S9 expired lease reclaimed with new token';
END $$;
