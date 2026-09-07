create table if not exists public.go_authorization_snapshots (
  erp_user_id uuid primary key,
  go_project_ref text not null,
  go_user_id text,
  payload_hash text not null,
  payload jsonb not null,
  version bigint not null default 1,
  computed_at timestamptz not null default now(),
  last_pulled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant all on public.go_authorization_snapshots to service_role;
alter table public.go_authorization_snapshots enable row level security;

create or replace function public.go_authorization_snapshot(
  p_erp_user_id uuid,
  p_go_user_id text,
  p_permission_rev integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_project constant text := 'narqwgwpqglathwtyevz';
  v_user auth.users%rowtype;
  v_exists boolean := false;
  v_roles text[] := array[]::text[];
  v_locations uuid[] := array[]::uuid[];
  v_is_hq boolean := false;
  v_identity_status text := null;
  v_shops jsonb := '[]'::jsonb;
  v_payload jsonb;
  v_hash text;
  v_row public.go_authorization_snapshots%rowtype;
begin
  select * into v_user from auth.users where id = p_erp_user_id;
  v_exists := found;

  select coalesce(array_agg(role::text order by role::text), array[]::text[])
    into v_roles
    from public.user_roles where user_id = p_erp_user_id;

  v_is_hq := v_roles && array['super_admin','hq_operator'];

  select coalesce(array_agg(location_id order by location_id), array[]::uuid[])
    into v_locations
    from public.user_location_perms where user_id = p_erp_user_id;

  -- 只看固定 GO 项目 + 当前已核验 go_user_id 的绑定；撤销优先
  select status into v_identity_status
    from public.go_identity_links
   where erp_user_id = p_erp_user_id
     and go_project_ref = v_project
     and (p_go_user_id is null or go_user_id = p_go_user_id)
   order by case when status = 'revoked' then 0 else 1 end, updated_at desc
   limit 1;

  select coalesce(
           jsonb_agg(jsonb_build_object(
             'go_shop_id', l.go_shop_id,
             'erp_location_id', l.location_id,
             'name', loc.name
           ) order by l.go_shop_id),
           '[]'::jsonb)
    into v_shops
    from public.go_shop_location_links l
    join public.inv_locations loc on loc.id = l.location_id
   where l.status = 'active'
     and l.go_project_ref = v_project
     and loc.kind = 'shop'
     and loc.is_active = true
     and (v_is_hq or l.location_id = any(v_locations));

  v_payload := jsonb_build_object(
    'erp_user_id', p_erp_user_id,
    'account_exists', v_exists,
    'banned', v_exists and v_user.banned_until is not null and v_user.banned_until > now(),
    'deleted', v_exists and v_user.deleted_at is not null,
    'roles', to_jsonb(v_roles),
    'location_ids', to_jsonb(v_locations),
    'identity_status', v_identity_status,
    'shop_links', v_shops,
    'permission_rev', p_permission_rev
  );
  v_hash := md5(v_payload::text);

  insert into public.go_authorization_snapshots as s
    (erp_user_id, go_project_ref, go_user_id, payload_hash, payload, version)
  values (p_erp_user_id, v_project, p_go_user_id, v_hash, v_payload, 1)
  on conflict (erp_user_id) do nothing;

  select * into v_row
    from public.go_authorization_snapshots
   where erp_user_id = p_erp_user_id
   for update;

  if v_row.payload_hash is distinct from v_hash then
    update public.go_authorization_snapshots
       set payload = v_payload,
           payload_hash = v_hash,
           version = v_row.version + 1,
           go_user_id = coalesce(p_go_user_id, go_user_id),
           computed_at = now(),
           last_pulled_at = now(),
           updated_at = now()
     where erp_user_id = p_erp_user_id
     returning * into v_row;
  else
    update public.go_authorization_snapshots
       set last_pulled_at = now(),
           go_user_id = coalesce(p_go_user_id, go_user_id),
           updated_at = now()
     where erp_user_id = p_erp_user_id
     returning * into v_row;
  end if;

  return v_payload
      || jsonb_build_object(
           'version', v_row.version,
           'generated_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         );
end;
$$;

drop function if exists public.go_authorization_ack(uuid, bigint);

create or replace function public.go_authorization_ack(
  p_erp_user_id uuid,
  p_version bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_project constant text := 'narqwgwpqglathwtyevz';
  v_row public.go_authorization_snapshots%rowtype;
  v_count integer := 0;
begin
  select * into v_row
    from public.go_authorization_snapshots
   where erp_user_id = p_erp_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'snapshot_missing');
  end if;

  if v_row.version is distinct from p_version then
    return jsonb_build_object('ok', false, 'code', 'version_stale',
                              'current_version', v_row.version);
  end if;

  with updated as (
    update public.go_scope_sync_outbox
       set status = 'synced',
           synced_at = now(),
           last_error = null,
           updated_at = now()
     where target_user_id = p_erp_user_id
       and go_project_ref = v_project
       and status <> 'synced'
       and created_at <= v_row.last_pulled_at
    returning 1
  )
  select count(*)::integer into v_count from updated;

  return jsonb_build_object('ok', true, 'confirmed', v_count, 'version', v_row.version);
end;
$$;

drop function if exists public.go_authorization_snapshot(uuid);

revoke all on function public.go_authorization_snapshot(uuid, text, integer) from public;
revoke all on function public.go_authorization_snapshot(uuid, text, integer) from anon;
revoke all on function public.go_authorization_snapshot(uuid, text, integer) from authenticated;
revoke all on function public.go_authorization_ack(uuid, bigint) from public;
revoke all on function public.go_authorization_ack(uuid, bigint) from anon;
revoke all on function public.go_authorization_ack(uuid, bigint) from authenticated;
grant execute on function public.go_authorization_snapshot(uuid, text, integer) to service_role;
grant execute on function public.go_authorization_ack(uuid, bigint) to service_role;