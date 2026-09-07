alter table public.go_authorization_snapshots
  add column if not exists permission_rev integer,
  add column if not exists pulled_outbox jsonb not null default '[]'::jsonb;

-- One-statement consistent read of all authorization facts + own outbox coverage.
create or replace function public.go_authorization_facts(
  p_erp_user_id uuid,
  p_go_user_id text,
  p_permission_rev integer
) returns jsonb
language sql
stable
security definer
set search_path to 'public', 'auth'
as $function$
  with params as (
    select 'narqwgwpqglathwtyevz'::text as project, clock_timestamp() as now_ts
  ),
  usr as (
    select u.id, u.banned_until, u.deleted_at from auth.users u where u.id = p_erp_user_id
  ),
  roles as (
    select coalesce(array_agg(r.role::text order by r.role::text), array[]::text[]) as roles
      from public.user_roles r where r.user_id = p_erp_user_id
  ),
  locs as (
    select coalesce(array_agg(p.location_id order by p.location_id), array[]::uuid[]) as location_ids
      from public.user_location_perms p where p.user_id = p_erp_user_id
  ),
  ident as (
    select l.status
      from public.go_identity_links l, params
     where l.erp_user_id = p_erp_user_id
       and l.go_project_ref = params.project
       and (p_go_user_id is null or l.go_user_id = p_go_user_id)
     order by case when l.status = 'revoked' then 0 when l.status = 'rejected' then 1 else 2 end,
              l.updated_at desc
     limit 1
  ),
  shops as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'go_shop_id', l.go_shop_id,
             'erp_location_id', l.location_id,
             'name', loc.name
           ) order by l.go_shop_id), '[]'::jsonb) as shop_links
      from public.go_shop_location_links l
      join public.inv_locations loc on loc.id = l.location_id, params, roles, locs
     where l.status = 'active'
       and l.go_project_ref = params.project
       and loc.kind = 'shop'
       and loc.is_active = true
       and ((roles.roles && array['super_admin','hq_operator']) or l.location_id = any(locs.location_ids))
  ),
  outbox as (
    select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'version', o.version) order by o.id), '[]'::jsonb) as items
      from public.go_scope_sync_outbox o, params
     where o.target_user_id = p_erp_user_id
       and o.go_project_ref = params.project
       and o.status <> 'synced'
  ),
  base as (
    select jsonb_build_object(
      'erp_user_id', p_erp_user_id,
      'account_exists', (select count(*) from usr) = 1,
      'banned', exists (select 1 from usr, params where usr.banned_until is not null and usr.banned_until > params.now_ts),
      'deleted', exists (select 1 from usr where usr.deleted_at is not null),
      'roles', to_jsonb(roles.roles),
      'location_ids', to_jsonb(locs.location_ids),
      'identity_status', (select status from ident),
      'shop_links', shops.shop_links,
      'permission_rev', p_permission_rev
    ) as payload
    from roles, locs, shops
  )
  select jsonb_build_object(
    'payload', base.payload || jsonb_build_object(
      'expected_link_status',
      case
        when (base.payload->>'account_exists')::boolean is not true then 'revoked'
        when (base.payload->>'deleted')::boolean then 'revoked'
        when (base.payload->>'banned')::boolean then 'revoked'
        when coalesce(base.payload->>'identity_status','') in ('revoked','rejected','') then 'revoked'
        when coalesce(base.payload->>'identity_status','') <> 'approved' then 'revoked'
        else 'active'
      end),
    'outbox', (select items from outbox),
    'now', (select now_ts from params)
  )
  from base;
$function$;

create or replace function public.go_authorization_snapshot(
  p_erp_user_id uuid,
  p_go_user_id text,
  p_permission_rev integer
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_project constant text := 'narqwgwpqglathwtyevz';
  v_facts jsonb;
  v_payload jsonb;
  v_outbox jsonb;
  v_now timestamptz;
  v_hash text;
  v_row public.go_authorization_snapshots%rowtype;
begin
  -- Serialize per ERP user BEFORE reading any authorization fact, so a slow
  -- reader can never publish a stale payload under a newer version.
  perform pg_advisory_xact_lock(hashtextextended('go_authz:' || p_erp_user_id::text, 0));

  v_facts := public.go_authorization_facts(p_erp_user_id, p_go_user_id, p_permission_rev);
  v_payload := v_facts->'payload';
  v_outbox := coalesce(v_facts->'outbox', '[]'::jsonb);
  v_now := (v_facts->>'now')::timestamptz;
  v_hash := md5(v_payload::text);

  insert into public.go_authorization_snapshots as s
    (erp_user_id, go_project_ref, go_user_id, permission_rev, payload_hash, payload,
     pulled_outbox, version, computed_at, last_pulled_at)
  values (p_erp_user_id, v_project, p_go_user_id, p_permission_rev, v_hash, v_payload,
          v_outbox, 1, v_now, v_now)
  on conflict (erp_user_id) do nothing;

  select * into v_row from public.go_authorization_snapshots
   where erp_user_id = p_erp_user_id for update;

  update public.go_authorization_snapshots
     set payload = v_payload,
         payload_hash = v_hash,
         permission_rev = p_permission_rev,
         pulled_outbox = v_outbox,
         version = case when v_row.payload_hash is distinct from v_hash
                        then v_row.version + 1 else v_row.version end,
         go_user_id = coalesce(p_go_user_id, go_user_id),
         computed_at = v_now,
         last_pulled_at = v_now,
         updated_at = v_now
   where erp_user_id = p_erp_user_id
   returning * into v_row;

  return v_payload || jsonb_build_object(
    'version', v_row.version,
    'generated_at', to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$function$;

drop function if exists public.go_authorization_ack(uuid, bigint);

create or replace function public.go_authorization_ack(
  p_erp_user_id uuid,
  p_version bigint,
  p_link_status text
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_project constant text := 'narqwgwpqglathwtyevz';
  v_row public.go_authorization_snapshots%rowtype;
  v_facts jsonb;
  v_payload jsonb;
  v_hash text;
  v_count integer := 0;
begin
  if p_link_status is null or p_link_status not in ('active','revoked') then
    return jsonb_build_object('ok', false, 'code', 'receipt_status_invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('go_authz:' || p_erp_user_id::text, 0));

  select * into v_row from public.go_authorization_snapshots
   where erp_user_id = p_erp_user_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'snapshot_missing');
  end if;

  if v_row.version is distinct from p_version then
    return jsonb_build_object('ok', false, 'code', 'version_stale',
                              'current_version', v_row.version);
  end if;

  -- Re-derive current facts under the same lock; a receipt may only confirm a
  -- snapshot that still matches reality. This read must NOT count as a pull.
  v_facts := public.go_authorization_facts(p_erp_user_id, v_row.go_user_id, v_row.permission_rev);
  v_payload := v_facts->'payload';
  v_hash := md5(v_payload::text);

  if v_hash is distinct from v_row.payload_hash then
    return jsonb_build_object('ok', false, 'code', 'authorization_changed',
                              'current_version', v_row.version);
  end if;

  if p_link_status is distinct from (v_payload->>'expected_link_status') then
    return jsonb_build_object('ok', false, 'code', 'receipt_status_mismatch',
                              'expected', v_payload->>'expected_link_status');
  end if;

  -- Only confirm the exact outbox rows captured at pull time, and only while
  -- each row's version is unchanged (same-id upsert bumps version).
  with captured as (
    select (e->>'id')::uuid as id, (e->>'version')::integer as version
      from jsonb_array_elements(coalesce(v_row.pulled_outbox, '[]'::jsonb)) e
  ),
  updated as (
    update public.go_scope_sync_outbox o
       set status = 'synced', synced_at = now(), last_error = null, updated_at = now()
      from captured c
     where o.id = c.id
       and o.target_user_id = p_erp_user_id
       and o.go_project_ref = v_project
       and o.status <> 'synced'
       and o.version = c.version
    returning 1
  )
  select count(*)::integer into v_count from updated;

  return jsonb_build_object('ok', true, 'confirmed', v_count, 'version', v_row.version);
end;
$function$;

revoke all on function public.go_authorization_facts(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.go_authorization_snapshot(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.go_authorization_ack(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.go_authorization_facts(uuid, text, integer) to service_role;
grant execute on function public.go_authorization_snapshot(uuid, text, integer) to service_role;
grant execute on function public.go_authorization_ack(uuid, bigint, text) to service_role;