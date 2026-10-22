\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION t(c boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT c THEN RAISE EXCEPTION 'FAIL %', label; END IF; RAISE NOTICE 'PASS %', label; END $$;
CREATE OR REPLACE FUNCTION upd(p_user uuid, p_patch jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN
  r := handheld_item_update('20000000-0000-0000-0000-000000000001', p_user, 'op-' || gen_random_uuid(), '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001', (SELECT updated_at FROM inv_skus WHERE id='10000000-0000-0000-0000-000000000001'), p_patch, 'fp');
  RETURN r->>'changed_fields';
EXCEPTION WHEN OTHERS THEN RETURN 'ERR:' || SQLERRM; END $$;
\set HQ '''00000000-0000-0000-0000-0000000000aa'''
\set STAFF '''00000000-0000-0000-0000-0000000000bb'''

SELECT t((SELECT featured_stamp IS NULL AND notice_tags = '{}' FROM inv_skus), 'existing SKU defaults to no marks');
SELECT t(upd(:HQ, '{"featured_stamp":"rare"}') = '["featured_stamp"]', 'set stamp');
SELECT t((SELECT name='old' AND notes='keep' AND grade='A' AND price_tier=39 AND notice_tags='{}' FROM inv_skus), 'partial update keeps other fields');
SELECT t(upd(:HQ, '{"notice_tags":["not_edible","flawed"]}') = '["notice_tags"]', 'set tags');
SELECT t((SELECT featured_stamp='rare' AND notice_tags='{flawed,not_edible}' FROM inv_skus), 'tags normalized, stamp kept');
SELECT t(upd(:HQ, '{"notice_tags":["function_uncertain","function_unavailable"]}') LIKE 'ERR:validation_error%', 'exclusive tags rejected by server');
SELECT t(upd(:HQ, '{"featured_stamp":"vintage"}') LIKE 'ERR:validation_error%', 'unknown stamp rejected');
SELECT t(upd(:HQ, '{"notice_tags":["broken"]}') LIKE 'ERR:validation_error%', 'unknown tag rejected');
SELECT t(upd(:STAFF, '{"featured_stamp":"new"}') LIKE 'ERR:edit_forbidden%', 'non-manager staff cannot edit');
CREATE TEMP TABLE clr AS SELECT upd(:HQ, '{"featured_stamp":null}') r;
SELECT t((SELECT r FROM clr) = '["featured_stamp"]' AND (SELECT featured_stamp IS NULL AND notice_tags='{flawed,not_edible}' FROM inv_skus), 'stamp clearable, tags kept');
DO $$ BEGIN UPDATE inv_skus SET notice_tags='{function_uncertain,function_unavailable}'; RAISE EXCEPTION 'FAIL table check allowed exclusive';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS table CHECK guards direct writes'; END $$;
DO $$ BEGIN UPDATE inv_skus SET featured_stamp='bogus'; RAISE EXCEPTION 'FAIL table check allowed bogus stamp';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS stamp CHECK guards direct writes'; END $$;

-- parts_missing（零件缺失）
SELECT t(upd(:HQ, '{"notice_tags":["parts_missing","function_unavailable","flawed"]}') = '["notice_tags"]', 'parts_missing accepted with others');
SELECT t((SELECT notice_tags='{flawed,function_unavailable,parts_missing}' FROM inv_skus), 'parts_missing normalized last in dictionary order');
SELECT t(upd(:HQ, '{"notice_tags":["function_uncertain","function_unavailable","parts_missing"]}') LIKE 'ERR:validation_error%', 'exclusivity still enforced with parts_missing');
SELECT t(upd(:HQ, '{"notice_tags":["flawed","function_unavailable"]}') = '["notice_tags"]'
  AND (SELECT notice_tags='{flawed,function_unavailable}' AND featured_stamp IS NULL FROM inv_skus), 'removing parts_missing clears it, stamp untouched');
DO $$ BEGIN
  BEGIN UPDATE inv_skus SET notice_tags='{parts_missing,parts_missing}'; RAISE EXCEPTION 'FAIL duplicate parts_missing allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE inv_skus SET notice_tags='{parts_missing}';
  ASSERT (SELECT notice_tags='{parts_missing}' FROM inv_skus), 'direct valid write';
  RAISE NOTICE 'PASS table CHECK accepts parts_missing, rejects duplicates';
END $$;
