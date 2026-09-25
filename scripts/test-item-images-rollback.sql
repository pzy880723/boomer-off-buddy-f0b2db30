-- Execute after the migration inside BEGIN/ROLLBACK. Creates only isolated uncommitted fixtures.
DO $test$
DECLARE
  v_sku uuid := gen_random_uuid(); v_listing uuid := gen_random_uuid();
  v_device uuid := gen_random_uuid(); v_user uuid; v_loc uuid;
  v_version timestamptz; v_result jsonb; v_paths text[];
  v_new text; v_before_code text; v_audit integer;
BEGIN
  SELECT user_id INTO v_user FROM public.user_roles WHERE role::text='super_admin' LIMIT 1;
  SELECT id INTO v_loc FROM public.inv_locations WHERE is_active ORDER BY id LIMIT 1;
  IF v_user IS NULL OR v_loc IS NULL THEN RAISE EXCEPTION 'test prerequisites missing'; END IF;
  INSERT INTO public.inv_skus(id,category,price_tier,name,epc,is_custom_price,stock_qty,image_paths,image_url)
  VALUES(v_sku,'toy_building_model',59.9,'ROLLBACK ONLY image editing test',v_sku::text,true,1,
    ARRAY['sku-raw/test/front.jpg','sku-raw/test/back.jpg'],'https://old.invalid/cover.jpg')
  RETURNING updated_at, barcode INTO v_version, v_before_code;
  INSERT INTO public.commerce_listings(id,sku_id,location_id,title,price,image_paths,image_urls,cover_url)
  VALUES(v_listing,v_sku,v_loc,'ROLLBACK ONLY image editing test',59.9,
    '["sku-raw/test/front.jpg","sku-raw/test/back.jpg"]','["https://old.invalid/cover.jpg"]','https://old.invalid/cover.jpg');

  v_result := public.handheld_item_update(v_device,v_user,'image-test-order',v_loc,v_sku,v_version,
    '{"image_paths":["sku-raw/test/back.jpg","sku-raw/test/front.jpg"]}','order');
  IF v_result->'changed_fields' <> '["image_paths"]'::jsonb OR (v_result->>'youzan_sync_queued')::int <> 0 THEN
    RAISE EXCEPTION 'wrong changed fields/outbox'; END IF;
  IF (SELECT image_paths FROM public.inv_skus WHERE id=v_sku) <> ARRAY['sku-raw/test/back.jpg','sku-raw/test/front.jpg'] THEN
    RAISE EXCEPTION 'reorder failed'; END IF;
  IF NOT (public.handheld_item_update(v_device,v_user,'image-test-order',v_loc,v_sku,v_version,
    '{"image_paths":["sku-raw/test/back.jpg","sku-raw/test/front.jpg"]}','order')->>'replayed')::boolean THEN
    RAISE EXCEPTION 'replay failed'; END IF;
  BEGIN
    PERFORM public.handheld_item_update(v_device,v_user,'image-test-order',v_loc,v_sku,v_version,
      '{"image_paths":[]}','different');
    RAISE EXCEPTION 'expected idempotency conflict';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM <> 'client_op_id_conflict' THEN RAISE; END IF; END;

  IF NOT public.handheld_apply_listing_image_result(v_sku,'sku-raw/test/front.jpg','sku-listing/test/front.jpg') THEN
    RAISE EXCEPTION 'worker should replace current source'; END IF;
  IF (SELECT image_paths FROM public.inv_skus WHERE id=v_sku) <> ARRAY['sku-raw/test/back.jpg','sku-listing/test/front.jpg'] THEN
    RAISE EXCEPTION 'worker changed order'; END IF;

  SELECT updated_at INTO v_version FROM public.inv_skus WHERE id=v_sku;
  BEGIN
    PERFORM public.handheld_item_update(v_device,gen_random_uuid(),'image-test-forbidden',v_loc,v_sku,v_version,'{"image_paths":[]}','deny');
    RAISE EXCEPTION 'expected scope rejection';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM <> 'location_forbidden' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.handheld_item_update(v_device,v_user,'image-test-version',v_loc,v_sku,'2000-01-01','{"image_paths":[]}','version');
    RAISE EXCEPTION 'expected version conflict';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM <> 'version_conflict' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.handheld_item_update(v_device,v_user,'image-test-foreign',v_loc,v_sku,v_version,
      '{"image_paths":["sku-raw/2026-09-25/foreign/a.jpg"]}','foreign');
    RAISE EXCEPTION 'expected upload ownership rejection';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM <> 'validation_error' THEN RAISE; END IF; END;

  v_new := '2026-09-25/'||v_device::text||'/test.jpg';
  INSERT INTO storage.objects(bucket_id,name) VALUES('sku-listing',v_new);
  v_result := public.handheld_item_update(v_device,v_user,'image-test-replace',v_loc,v_sku,v_version,
    jsonb_build_object('image_paths',jsonb_build_array('sku-listing/'||v_new,'sku-listing/test/front.jpg')),'replace');
  IF public.handheld_apply_listing_image_result(v_sku,'sku-raw/test/back.jpg','sku-listing/test/back.jpg') THEN
    RAISE EXCEPTION 'deleted image resurrected'; END IF;
  IF (SELECT image_paths FROM public.commerce_listings WHERE id=v_listing) <>
      jsonb_build_array('sku-listing/'||v_new,'sku-listing/test/front.jpg') THEN
    RAISE EXCEPTION 'commerce not updated'; END IF;
  IF (SELECT image_urls <> '[]'::jsonb OR cover_url IS NOT NULL FROM public.commerce_listings WHERE id=v_listing) THEN
    RAISE EXCEPTION 'stale commerce fallback'; END IF;
  SELECT updated_at INTO v_version FROM public.inv_skus WHERE id=v_sku;
  v_result := public.handheld_item_update(v_device,v_user,'image-test-clear',v_loc,v_sku,v_version,'{"image_paths":[]}','clear');
  IF (SELECT cardinality(image_paths) <> 0 OR image_url IS NOT NULL OR stock_qty <> 1 OR price_tier <> 59.9 OR barcode <> v_before_code
      FROM public.inv_skus WHERE id=v_sku) THEN RAISE EXCEPTION 'clear changed unrelated fields or retained cover'; END IF;
  SELECT count(*) INTO v_audit FROM public.handheld_item_audit WHERE sku_id=v_sku;
  IF v_audit <> 3 THEN RAISE EXCEPTION 'audit/replay count incorrect: %',v_audit; END IF;
  IF has_function_privilege('anon','public.handheld_apply_listing_image_result(uuid,text,text)','execute')
     OR has_function_privilege('authenticated','public.handheld_apply_listing_image_result(uuid,text,text)','execute') THEN
    RAISE EXCEPTION 'AI mutation must be service only'; END IF;
END;
$test$;
