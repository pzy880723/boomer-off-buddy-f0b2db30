\set ON_ERROR_STOP 1
insert into channel_sync_outbox(id, sku_id, action) values
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','set_stock_zero'),
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000a1','delist'),
 ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000b2','set_stock_zero');
do $$ declare n int; ok boolean; begin
  -- canary：限定 sku+action 只领到一条
  select count(*) into n from claim_channel_sync_tasks_v2('w1', 10, 60, '00000000-0000-0000-0000-0000000000a1', 'delist');
  if n <> 1 then raise exception 'FAIL canary claimed %', n; end if;
  raise notice 'PASS canary filter claims only the scoped sku/action';
  -- 未过期租约不可被他人领取；过期后可重取，原 worker 被 fencing
  select count(*) into n from claim_channel_sync_tasks_v2('w2', 10, 60, '00000000-0000-0000-0000-0000000000a1', 'delist');
  if n <> 0 then raise exception 'FAIL live lease stolen'; end if;
  update channel_sync_outbox set lease_expires_at = now() - interval '1 second' where id='00000000-0000-0000-0000-000000000002';
  select count(*) into n from claim_channel_sync_tasks_v2('w2', 10, 60, '00000000-0000-0000-0000-0000000000a1', 'delist');
  if n <> 1 then raise exception 'FAIL expired lease not reclaimable'; end if;
  ok := finish_channel_sync_task('00000000-0000-0000-0000-000000000002', 'w1', 'succeeded', null, null);
  if ok then raise exception 'FAIL stale worker finished'; end if;
  ok := finish_channel_sync_task('00000000-0000-0000-0000-000000000002', 'w2', 'succeeded', null, null);
  if not ok then raise exception 'FAIL owner finish'; end if;
  if (select status from channel_sync_outbox where id='00000000-0000-0000-0000-000000000002') <> 'succeeded' then raise exception 'FAIL status'; end if;
  ok := finish_channel_sync_task('00000000-0000-0000-0000-000000000002', 'w2', 'succeeded', null, null);
  if ok then raise exception 'FAIL double finish'; end if;
  raise notice 'PASS expired lease reclaimable; stale worker fenced; finish once';
  -- 不允许非法终态
  begin perform finish_channel_sync_task('00000000-0000-0000-0000-000000000001', 'w1', 'bogus', null, null); raise exception 'FAIL bogus accepted';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS invalid status rejected'; end $$;
select has_function_privilege('anon','claim_channel_sync_tasks_v2(text,integer,integer,uuid,text)','execute') as anon_claim \gset
\if :anon_claim
\echo FAIL anon can claim
\else
\echo PASS client roles cannot call
\endif
