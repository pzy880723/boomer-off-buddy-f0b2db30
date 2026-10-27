CREATE OR REPLACE FUNCTION retry_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF; RAISE NOTICE 'PASS %',label; END $$;
INSERT INTO inv_skus(id,category,price_tier,name,epc,image_paths) VALUES ('b2700000-0000-0000-0000-000000000011','c',1,'retry fixture','retry-fixture',ARRAY['sku-raw/test/retry.jpg']);
INSERT INTO inv_listing_image_jobs(id,sku_id,source_bucket,source_path,status,attempts,claim_token,lease_until,readiness_revision)
VALUES ('b2700000-0000-0000-0000-000000000012','b2700000-0000-0000-0000-000000000011','sku-raw','test/retry.jpg','processing',5,'b2700000-0000-0000-0000-000000000013',now()+interval '4 minutes',1);
SELECT retry_assert(handheld_listing_image_finish('b2700000-0000-0000-0000-000000000012','b2700000-0000-0000-0000-000000000013',NULL,'[image_generation] no image')='retryable_failed','fifth transient failure remains retryable');
SELECT retry_assert((SELECT next_run_at>=now()+interval '899 seconds' FROM inv_listing_image_jobs WHERE id='b2700000-0000-0000-0000-000000000012'),'fifth failure cools down');
SELECT retry_assert((SELECT count(*)=0 FROM handheld_listing_image_claim(6)),'cooldown prevents hot reclaim');
UPDATE inv_listing_image_jobs SET next_run_at=now()-interval '1 second' WHERE id='b2700000-0000-0000-0000-000000000012';
SELECT retry_assert((SELECT count(*)=1 FROM handheld_listing_image_claim(6)),'sixth attempt can claim');
SELECT retry_assert((SELECT attempts=6 FROM inv_listing_image_jobs WHERE id='b2700000-0000-0000-0000-000000000012'),'attempt history retained');