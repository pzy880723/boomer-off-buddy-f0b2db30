\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION t(c boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT c THEN RAISE EXCEPTION 'FAIL %', label; END IF; RAISE NOTICE 'PASS %', label; END $$;

INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('a0000000-0000-0000-0000-000000000041','sub-41','18600000041','active');
INSERT INTO commerce_customer_identities (customer_id, provider, provider_subject) VALUES
  ('a0000000-0000-0000-0000-000000000041','phone','18600000041');
SELECT t((SELECT subject_snapshot FROM commerce_newcomer_grants WHERE customer_id='a0000000-0000-0000-0000-000000000041')='sub-41', 'grant snapshots external_subject');
CREATE TEMP TABLE ic AS SELECT * FROM commerce_newcomer_claim_scoped(1, 60, ARRAY['a0000000-0000-0000-0000-000000000041']::uuid[]);
CREATE OR REPLACE FUNCTION chk() RETURNS jsonb LANGUAGE sql AS $$
  SELECT commerce_newcomer_identity_check((SELECT slot_id FROM ic), (SELECT claim_token FROM ic)) $$;
SELECT t(chk()->>'status'='ok', 'unchanged identity passes');
SELECT t(commerce_newcomer_identity_check((SELECT slot_id FROM ic), gen_random_uuid())->>'status'='stale', 'wrong claim token is stale');

UPDATE commerce_customers SET phone='18600000049' WHERE id='a0000000-0000-0000-0000-000000000041';
SELECT t(chk()->>'reason'='phone_changed', 'changed phone blocks queued slot');
UPDATE commerce_customers SET phone='18600000041' WHERE id='a0000000-0000-0000-0000-000000000041';

UPDATE commerce_customers SET external_subject='sub-other' WHERE id='a0000000-0000-0000-0000-000000000041';
SELECT t(chk()->>'reason'='external_subject_changed', 'changed external_subject blocks');
UPDATE commerce_customers SET external_subject='sub-41' WHERE id='a0000000-0000-0000-0000-000000000041';

UPDATE commerce_customer_identities SET provider_subject='18600000048' WHERE customer_id='a0000000-0000-0000-0000-000000000041';
SELECT t(chk()->>'reason'='phone_identity_mismatch', 'phone identity mismatch blocks');
UPDATE commerce_customer_identities SET provider_subject='18600000041' WHERE customer_id='a0000000-0000-0000-0000-000000000041';

INSERT INTO commerce_customers (id, external_subject, phone, status) VALUES
  ('a0000000-0000-0000-0000-000000000042','sub-42',NULL,'active');
INSERT INTO commerce_customer_identities (customer_id, provider, provider_subject) VALUES
  ('a0000000-0000-0000-0000-000000000042','phone','186 0000 0041');
SELECT t(chk()->>'reason'='phone_identity_conflict', 'same phone identity on another customer blocks');
DELETE FROM commerce_customer_identities WHERE customer_id='a0000000-0000-0000-0000-000000000042';

UPDATE commerce_customers SET status='disabled' WHERE id='a0000000-0000-0000-0000-000000000041';
SELECT t(chk()->>'reason'='customer_inactive', 'deactivated customer blocks');
UPDATE commerce_customers SET status='active' WHERE id='a0000000-0000-0000-0000-000000000041';
SELECT t(chk()->>'status'='ok', 'restored identity passes again');

SELECT t(NOT has_function_privilege('authenticated','commerce_newcomer_identity_check(uuid,uuid)','EXECUTE'), 'identity_check service-role only');
