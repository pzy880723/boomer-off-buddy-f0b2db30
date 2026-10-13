\set ON_ERROR_STOP on
CREATE FUNCTION t(name text, paths text[], jobs text[][], expect text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s uuid := gen_random_uuid(); i int; got text;
BEGIN
  INSERT INTO inv_skus(id,image_paths) VALUES (s,paths);
  IF jobs IS NOT NULL THEN FOR i IN 1..array_length(jobs,1) LOOP
    INSERT INTO inv_listing_image_jobs(sku_id,source_bucket,source_path,target_path,status)
    VALUES (s,'sku-raw',jobs[i][1],nullif(jobs[i][2],''),jobs[i][3]); END LOOP; END IF;
  PERFORM public.handheld_listing_image_refresh_status(s);
  SELECT image_processing_status INTO got FROM inv_skus WHERE id=s;
  IF got IS DISTINCT FROM expect THEN RAISE EXCEPTION 'FAIL % got % want %',name,got,expect; END IF;
  RAISE NOTICE 'PASS %', name;
END $$;
SELECT t('all_terminal', ARRAY['sku-raw/a','sku-raw/b'], ARRAY[['a','','permanent_failed'],['b','','permanent_failed']], 'failed');
SELECT t('partial_terminal', ARRAY['sku-listing/a.out','sku-raw/b'], ARRAY[['a','a.out','succeeded'],['b','','permanent_failed']], 'partial_failed_terminal');
SELECT t('still_retryable', ARRAY['sku-raw/a','sku-raw/b'], ARRAY[['a','','retryable_failed'],['b','','permanent_failed']], 'retryable_failed');
SELECT t('deleted_old_job_ignored', ARRAY['sku-listing/a.out'], ARRAY[['a','a.out','succeeded'],['gone','','permanent_failed']], 'succeeded');
SELECT t('only_removed_jobs_idle', ARRAY['sku-raw/new'], ARRAY[['gone','','permanent_failed']], 'idle');
SELECT t('processing_first', ARRAY['sku-raw/a','sku-raw/b','sku-raw/c'], ARRAY[['a','','processing'],['b','','queued'],['c','','permanent_failed']], 'processing');
SELECT t('queued_over_retryable', ARRAY['sku-raw/a','sku-raw/b'], ARRAY[['a','','queued'],['b','','retryable_failed']], 'queued');
SELECT t('all_succeeded', ARRAY['sku-listing/a.out','sku-listing/b.out'], ARRAY[['a','a.out','succeeded'],['b','b.out','succeeded']], 'succeeded');
SELECT t('no_jobs_idle', ARRAY['sku-raw/x'], NULL, 'idle');
DO $$ BEGIN
  IF (SELECT proacl::text FROM pg_proc WHERE proname='handheld_listing_image_refresh_status') NOT LIKE '%service_role=X%' THEN RAISE EXCEPTION 'FAIL grants'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE proname='handheld_listing_image_refresh_status') THEN RAISE EXCEPTION 'FAIL secdef'; END IF;
  RAISE NOTICE 'PASS grants_security_unchanged'; END $$;
