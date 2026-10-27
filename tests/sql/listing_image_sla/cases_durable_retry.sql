CREATE OR REPLACE FUNCTION retry_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF; RAISE NOTICE 'PASS %',label; END $$;
INSERT INTO inv_skus(id,category,price_tier,name,epc,image_paths) VALUES ('b2700000-0000-0000-0000-000000000011','c',1,'retry fixture','retry-fixture',ARRAY['sku-raw/test/retry.jpg']);
INSERT INTO inv_listing_image_jobs(id,sku_id,source_bucket,source_path,status,attempts,claim_token,lease_until,readiness_revision)
VALUES ('b2700000-0000-0000-0000-000000000012','b2700000-0000-0000-0000-000000000011','sku-raw','test/retry.jpg','processing',5,'b2700000-0000-0000-0000-000000000013',now()+interval '4 minutes',1);
SELECT retry_assert(handheld_listing_image_finish('b2700000-0000-0000-0000-000000000012','b2700000-0000-0000-0000-000000000013',NULL,'[image_generation] no image')='retryable_failed','fifth transient failure remains retryable');
SELECT retry_assert((SELECT next_run_at>=now()+interval '899 seconds' FROM inv_listing_image_jobs WHERE id='b2700000-0000-0000-0000-000000000012'),'fifth failure cools down');
SELECT retry_assert((SELECT count(*)=0 FROM handheld_listing_image_claim(6) WHERE id='b2700000-0000-0000-0000-000000000012'),'cooldown prevents hot reclaim');
UPDATE inv_listing_image_jobs SET next_run_at=now()-interval '1 second' WHERE id='b2700000-0000-0000-0000-000000000012';
SELECT retry_assert((SELECT count(*)=1 FROM handheld_listing_image_claim(6) WHERE id='b2700000-0000-0000-0000-000000000012'),'sixth attempt can claim');
SELECT retry_assert((SELECT attempts=6 FROM inv_listing_image_jobs WHERE id='b2700000-0000-0000-0000-000000000012'),'attempt history retained');
SELECT retry_assert(handheld_listing_image_finish('b2700000-0000-0000-0000-000000000012','b2700000-0000-0000-0000-000000000013',NULL,'timeout')='stale','old claim token cannot finish newer attempt');
UPDATE inv_listing_image_jobs SET lease_until=now()-interval '1 second' WHERE id='b2700000-0000-0000-0000-000000000012';
SELECT count(*) FROM handheld_listing_image_claim(6);
SELECT retry_assert((SELECT status='retryable_failed' AND next_run_at>now() AND attempts=6 FROM inv_listing_image_jobs WHERE id='b2700000-0000-0000-0000-000000000012'),'expired lease persists cooldown without increment');
SELECT retry_assert(image_retry_delay(2147483647,'timeout')=interval '6 hours','huge attempts bounded at six hour cooldown');
SELECT retry_assert(image_retry_delay(1,'AI gateway 429')>=interval '15 minutes','rate limit minimum cooldown');
SELECT retry_assert(image_job_permanent_error('ai_consent_missing: denied'),'denied consent remains permanent');
SELECT retry_assert(NOT image_job_permanent_error('ai_consent_unavailable: read failed'),'consent read failure remains retryable');
SELECT retry_assert(image_job_permanent_error('Unsupported original image format'),'invalid original remains permanent');
SELECT retry_assert(NOT image_job_permanent_error('[image_validation] quality check failed'),'quality failure retries without weakening checks');
SELECT retry_assert(image_job_permanent_error('[image_generation] 图像生成服务未返回图片（content_filter），原图保留'),'provider refusal never retries');
SELECT retry_assert(NOT image_job_permanent_error('[image_generation] 图像生成服务未返回图片（stop），原图保留'),'ordinary empty output stays retryable');