-- Local readiness_test only: actual base/v2/v3 commit and 0112–0115 gates, no AI/provider calls.
CREATE FUNCTION pg_temp.minimal_sku(tag text) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object(
'name','未分类商品-'||tag,'price_tier',59.9,'is_custom_price',true,'inventory_policy','tracked',
'epc','OPTIONAL-'||tag,'sku_code','SKU-XX-'||tag,'image_paths',jsonb_build_array('sku-raw/test/'||tag||'.jpg')) $$;
DO $$
DECLARE d uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); l uuid:='00000000-0000-0000-0000-00000000000a'; a jsonb; b jsonb; sid uuid; rejected boolean; payload jsonb;
BEGIN
a:=handheld_smart_create_commit_v3(d,u,'optional-001','fp1',l,false,pg_temp.minimal_sku('one'),'{}','isolated',NULL,'raw_declined','2026-10-09-v1',NULL);
sid:=(a->>'sku_id')::uuid;
PERFORM strict_assert(sid IS NOT NULL,'title price context only commit succeeds without category');
PERFORM strict_assert((SELECT category='' AND grade IS NULL AND ip_id IS NULL AND attributes='{}'::jsonb FROM inv_skus WHERE id=sid),'no optional metadata or fabricated category');
PERFORM strict_assert((SELECT image_paths=ARRAY['sku-raw/test/one.jpg'] FROM inv_skus WHERE id=sid),'original paths preserved atomically');
PERFORM strict_assert(NOT listing_readiness_is_ready(sid),'uncategorized raw ERP SKU not storefront ready');
INSERT INTO commerce_listings(sku_id,location_id,title,price,status) VALUES(sid,l,'未分类商品',59.9,'published');
PERFORM strict_assert((SELECT status='hidden' AND readiness_hold FROM commerce_listings WHERE sku_id=sid),'unready manual published request held hidden');
b:=handheld_smart_create_commit_v3(d,u,'optional-001','fp1',l,false,pg_temp.minimal_sku('one'),'{}','isolated',NULL,'raw_declined','2026-10-09-v1',NULL);
PERFORM strict_assert(b->>'sku_id'=a->>'sku_id' AND (b->>'replayed')::boolean,'retry same op returns original SKU');
PERFORM strict_assert((SELECT count(*)=1 FROM inv_stock_movements WHERE sku_id=sid),'retry does not duplicate inventory movement');
PERFORM strict_assert((SELECT count(*)=1 FROM inv_skus WHERE name='未分类商品-one'),'retry does not duplicate SKU');
BEGIN PERFORM handheld_smart_create_commit_v3(d,u,'optional-001','other',l,false,pg_temp.minimal_sku('one'),'{}','isolated',NULL,'raw_declined','2026-10-09-v1',NULL); rejected:=false; EXCEPTION WHEN SQLSTATE 'P0409' THEN rejected:=true; END;
PERFORM strict_assert(rejected,'payload conflict remains rejected');
FOR payload IN SELECT v FROM (VALUES (pg_temp.minimal_sku('badtitle')||'{"name":"  "}'::jsonb),(pg_temp.minimal_sku('badprice')||'{"price_tier":0}'::jsonb),(pg_temp.minimal_sku('badprecision')||'{"price_tier":59.999}'::jsonb)) t(v) LOOP
rejected:=false;
BEGIN PERFORM handheld_smart_create_commit_v3(d,u,NULL,'fpbad',l,false,payload,'{}','isolated',NULL,'raw_declined','2026-10-09-v1',NULL); EXCEPTION WHEN SQLSTATE '22023' THEN rejected:=true; END;
PERFORM strict_assert(rejected,'DB rejects invalid required title or price before write');
END LOOP;
a:=handheld_smart_create_commit_v3(d,u,'optional-null','fpnull',l,false,pg_temp.minimal_sku('null')||'{"category":null}'::jsonb,'{}','isolated',NULL,'raw_declined','2026-10-09-v1',NULL);
PERFORM strict_assert((SELECT category='' FROM inv_skus WHERE id=(a->>'sku_id')::uuid),'explicit null category cannot violate NOT NULL');
PERFORM strict_assert(NOT storefront_image_ready((a->>'sku_id')::uuid),'new unclassified SKU never uses legacy exemption');
END $$;