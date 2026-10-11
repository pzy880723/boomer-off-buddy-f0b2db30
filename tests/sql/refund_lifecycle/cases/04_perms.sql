\set ON_ERROR_STOP 0
SET ROLE authenticated;
DO $$ BEGIN PERFORM commerce_order_settlement_block(gen_random_uuid()); RAISE EXCEPTION 'auth can call'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS authenticated denied settlement guard'; WHEN undefined_function THEN RAISE EXCEPTION 'guard function missing'; END $$;
DO $$ BEGIN PERFORM commerce_fulfillment_pick_facts(gen_random_uuid()); RAISE EXCEPTION 'auth can call'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS authenticated denied pick facts'; WHEN undefined_function THEN RAISE EXCEPTION 'pick facts function missing'; END $$;
RESET ROLE;
