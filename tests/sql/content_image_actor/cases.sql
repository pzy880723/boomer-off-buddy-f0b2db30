\set ON_ERROR_STOP 1
\set A '''aaaaaaaa-0000-0000-0000-000000000001'''
\set B '''bbbbbbbb-0000-0000-0000-000000000002'''
insert into public.inv_skus values ('11111111-1111-1111-1111-111111111111','active',true,'single',array['sku-raw/x/1.jpg','sku-raw/x/2.jpg']);
-- historical actor-less job on another block must never be claimed by later publishers
insert into public.inv_product_content_image_jobs(sku_id,block_id,source_path) values ('11111111-1111-1111-1111-111111111111','old','sku-raw/x/old.jpg');
do $$ declare r jsonb; begin
  r := public.handheld_product_content('dddddddd-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
    '99999999-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111',
    '{"action":"save","expected_version":0,"client_op_id":"op-a-0001","publish":true,"blocks":[{"id":"b1","type":"image","storage_path":"sku-raw/x/1.jpg"}]}','2026-10-09-v1');
end $$;
select case when ai_actor_user_id = :A::uuid and ai_policy_version='2026-10-09-v1' then 'PASS job bound to publisher A in same tx' else 'FAIL bind' end from public.inv_product_content_image_jobs where block_id='b1';
-- worker claims first (processing) -> actor must already be present
update public.inv_product_content_image_jobs set status='processing', attempts=1 where block_id='b1';
select case when ai_actor_user_id is not null then 'PASS claimed-first job still carries actor' else 'FAIL claim race' end from public.inv_product_content_image_jobs where block_id='b1';
-- B publishes again keeping b1 (in flight) and adding b2: b1 keeps A, b2 gets B, old stays NULL
do $$ begin
  perform public.handheld_product_content('dddddddd-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002',
    '99999999-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111',
    '{"action":"save","expected_version":1,"client_op_id":"op-b-0001","publish":true,"blocks":[{"id":"b1","type":"image","storage_path":"sku-raw/x/1.jpg"},{"id":"b2","type":"image","storage_path":"sku-raw/x/2.jpg"}]}','2026-10-09-v1');
end $$;
select case when (select ai_actor_user_id from public.inv_product_content_image_jobs where block_id='b1') = :A::uuid then 'PASS in-flight job not re-attributed to later editor' else 'FAIL steal' end;
select case when (select ai_actor_user_id from public.inv_product_content_image_jobs where block_id='b2') = :B::uuid then 'PASS new job bound to B' else 'FAIL b2' end;
select case when (select ai_actor_user_id from public.inv_product_content_image_jobs where block_id='old') is null then 'PASS historical NULL job untouched' else 'FAIL historical claimed' end;
-- terminal job re-queued by C's publish is re-bound to C (it is C's own re-queue)
update public.inv_product_content_image_jobs set status='succeeded' where block_id='b1';
do $$ begin
  perform public.handheld_product_content('dddddddd-0000-0000-0000-000000000003','cccccccc-0000-0000-0000-000000000003',
    '99999999-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111',
    '{"action":"save","expected_version":2,"client_op_id":"op-c-0001","publish":true,"blocks":[{"id":"b1","type":"image","storage_path":"sku-raw/x/1.jpg"}]}','2026-10-09-v1');
end $$;
select case when (select ai_actor_user_id::text||status from public.inv_product_content_image_jobs where block_id='b1') = 'cccccccc-0000-0000-0000-000000000003queued' then 'PASS re-queue bound to re-queuing publisher' else 'FAIL requeue' end;
-- missing policy version is rejected (no unattributed jobs)
do $$ begin
  begin
    perform public.handheld_product_content('dddddddd-0000-0000-0000-000000000004','cccccccc-0000-0000-0000-000000000003',
      '99999999-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111','{"action":"get"}',null);
    raise notice 'FAIL null policy accepted';
  exception when others then raise notice 'PASS null policy rejected';
  end;
end $$;
