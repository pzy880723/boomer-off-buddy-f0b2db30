-- Synthetic fixture: stock permission A, customer-service permission B.
INSERT INTO support_conversations(id,location_id,title) VALUES
 ('bbbbbbbb-0000-4000-8000-000000000001','5c000000-0000-4000-8000-00000000000b','support B'),
 ('bbbbbbbb-0000-4000-8000-000000000002',NULL,'HQ support');
INSERT INTO support_messages(conversation_id,sender_type,body) VALUES
 ('bbbbbbbb-0000-4000-8000-000000000001','customer','synthetic'),
 ('bbbbbbbb-0000-4000-8000-000000000002','customer','synthetic');
INSERT INTO fulfillments(id,order_id,location_id,status) VALUES
 ('ffffffff-0000-4000-8000-000000000001','0a000000-0000-4000-8000-000000000007','5c000000-0000-4000-8000-00000000000b','allocated');
DO $$ DECLARE r jsonb; BEGIN
 r := handheld_work_items_scoped(NULL,ARRAY['5c000000-0000-4000-8000-00000000000a']::uuid[],false,1000,NULL,NULL,
   ARRAY['5c000000-0000-4000-8000-00000000000b']::uuid[],false);
 ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'items') i WHERE i->>'id'='bbbbbbbb-0000-4000-8000-000000000001'), 'support B missing';
 ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'items') i WHERE i->>'id'='ffffffff-0000-4000-8000-000000000001'), 'support B grants leaked order B';
 ASSERT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'items') i WHERE i->>'id'='bbbbbbbb-0000-4000-8000-000000000002'), 'explicit store leaks HQ';
 r := handheld_work_items_scoped(NULL,'{}'::uuid[],false,1000,NULL,NULL,
   ARRAY['5c000000-0000-4000-8000-00000000000b']::uuid[],true);
 ASSERT (r->'counts'->>'customers')::int=2, 'support-only account cannot read authorized customer work';
 ASSERT (r->'counts'->>'orders')::int=0 AND (r->'counts'->>'internal')::int=0 AND (r->'counts'->>'system')::int=0,
   'support-only account gained business work';
 ASSERT r->'counts'=handheld_pending_counts_scoped(NULL,'{}'::uuid[],false,ARRAY['5c000000-0000-4000-8000-00000000000b']::uuid[],true), 'count stream mismatch';
 ASSERT NOT has_function_privilege('anon','public.handheld_work_items_scoped(uuid,uuid[],boolean,integer,timestamptz,uuid,uuid[],boolean,boolean,boolean)','EXECUTE');
 ASSERT NOT has_function_privilege('authenticated','public.handheld_pending_counts_scoped(uuid,uuid[],boolean,uuid[],boolean)','EXECUTE');
 RAISE NOTICE 'PASS independent support and business scopes, HQ-only support, count consistency, service-only grants';
END $$;
