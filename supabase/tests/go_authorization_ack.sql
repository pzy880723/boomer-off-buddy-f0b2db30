-- Rollback-only regression drill for the GO authorization snapshot/ack contract.
-- Run with: psql -f this file (it always ends in ROLLBACK; it writes nothing permanent).
--
-- Covers:
--   A. same-id outbox upsert after pull (version bumped) must NOT be confirmed
--   B. authorization facts changed after pull with no new pull -> ack refused
--   C. slow old pull vs new pull interleave -> old version stale, new pull only
--      confirms the rows it actually captured
--   D. receipt link_status must match the ERP-derived expectation
begin;
create temp table res(seq serial, step text, detail text) on commit drop;
do $$
declare u uuid; snap jsonb; v1 bigint; v2 bigint; expected text; oid1 uuid; oid2 uuid; ack jsonb;
begin
  select user_id into u from public.user_roles where role='super_admin' order by created_at limit 1;
  delete from public.go_authorization_snapshots where erp_user_id=u;

  -- A
  insert into public.go_scope_sync_outbox(go_project_ref,subject_type,subject_key,target_user_id,change_kind,payload,status,attempts,version)
    values ('narqwgwpqglathwtyevz','user_scope','t-a',u,'grant','{}','pending',0,1) returning id into oid1;
  snap := public.go_authorization_snapshot(u,'go-uid-1',2);
  v1 := (snap->>'version')::bigint; expected := snap->>'expected_link_status';
  update public.go_scope_sync_outbox set version = version + 1, change_kind='revoke' where id=oid1;
  ack := public.go_authorization_ack(u, v1, expected);
  insert into res(step,detail) values ('A same_id_upsert_after_pull',
    format('ack=%s row=%s (expect confirmed=0 / pending)', ack::text,
           (select status from public.go_scope_sync_outbox where id=oid1)));

  -- B
  insert into public.user_location_perms(user_id, location_id)
    select u, id from public.inv_locations where kind='shop' and is_active
      and id not in (select location_id from public.user_location_perms where user_id=u) limit 1;
  insert into res(step,detail) values ('B authz_changed_no_new_pull',
    public.go_authorization_ack(u, v1, expected)::text);

  -- C
  snap := public.go_authorization_snapshot(u,'go-uid-1',2);
  v2 := (snap->>'version')::bigint; expected := snap->>'expected_link_status';
  insert into public.go_scope_sync_outbox(go_project_ref,subject_type,subject_key,target_user_id,change_kind,payload,status,attempts,version)
    values ('narqwgwpqglathwtyevz','user_scope','t-c',u,'grant','{}','pending',0,1) returning id into oid2;
  insert into res(step,detail) values ('C old_pull_ack', public.go_authorization_ack(u, v1, expected)::text);
  insert into res(step,detail) values ('C new_pull_ack',
    format('%s new_row=%s', public.go_authorization_ack(u, v2, expected)::text,
           (select status from public.go_scope_sync_outbox where id=oid2)));

  -- D
  insert into res(step,detail) values ('D wrong_status',
    public.go_authorization_ack(u, v2, case when expected='active' then 'revoked' else 'active' end)::text);
  insert into res(step,detail) values ('D invalid_status', public.go_authorization_ack(u, v2, 'applied')::text);
end $$;
select step, detail from res order by seq;
rollback;
