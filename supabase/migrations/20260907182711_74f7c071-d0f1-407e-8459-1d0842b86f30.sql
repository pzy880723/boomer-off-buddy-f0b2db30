create or replace function public.go_authorization_snapshot(p_erp_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_user auth.users%rowtype;
  v_exists boolean := false;
  v_roles text[] := array[]::text[];
  v_locations uuid[] := array[]::uuid[];
  v_identity_status text := null;
  v_shops jsonb := '[]'::jsonb;
  v_version bigint := 0;
begin
  select * into v_user from auth.users where id = p_erp_user_id;
  v_exists := found;

  select coalesce(array_agg(role::text order by role::text), array[]::text[])
    into v_roles
    from public.user_roles where user_id = p_erp_user_id;

  select coalesce(array_agg(location_id), array[]::uuid[])
    into v_locations
    from public.user_location_perms where user_id = p_erp_user_id;

  select status into v_identity_status
    from public.go_identity_links
   where erp_user_id = p_erp_user_id
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
   where l.status = 'active' and loc.is_active = true;

  select greatest(
      coalesce((select max(version) from public.go_scope_sync_outbox where target_user_id = p_erp_user_id), 0),
      coalesce((select max((extract(epoch from created_at) * 1000)::bigint) from public.user_roles where user_id = p_erp_user_id), 0),
      coalesce((select max((extract(epoch from created_at) * 1000)::bigint) from public.user_location_perms where user_id = p_erp_user_id), 0),
      coalesce((select max((extract(epoch from greatest(created_at, updated_at, coalesce(revoked_at, created_at))) * 1000)::bigint)
                  from public.go_identity_links where erp_user_id = p_erp_user_id), 0),
      coalesce((select max((extract(epoch from greatest(created_at, updated_at)) * 1000)::bigint)
                  from public.go_shop_location_links), 0),
      case when v_exists then
        greatest(
          coalesce((extract(epoch from v_user.updated_at) * 1000)::bigint, 0),
          coalesce((extract(epoch from v_user.banned_until) * 1000)::bigint, 0),
          coalesce((extract(epoch from v_user.deleted_at) * 1000)::bigint, 0)
        )
      else 0 end
    ) into v_version;

  return jsonb_build_object(
    'erp_user_id', p_erp_user_id,
    'account_exists', v_exists,
    'banned', v_exists and v_user.banned_until is not null and v_user.banned_until > now(),
    'deleted', v_exists and v_user.deleted_at is not null,
    'roles', to_jsonb(v_roles),
    'location_ids', to_jsonb(v_locations),
    'identity_status', v_identity_status,
    'shop_links', v_shops,
    'version', v_version,
    'generated_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end;
$$;

create or replace function public.go_authorization_ack(p_erp_user_id uuid, p_version bigint)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  with updated as (
    update public.go_scope_sync_outbox
       set status = 'synced',
           synced_at = now(),
           last_error = null,
           updated_at = now()
     where target_user_id = p_erp_user_id
       and status <> 'synced'
       and version <= p_version
    returning 1
  )
  select count(*)::integer into v_count from updated;
  return v_count;
end;
$$;

revoke all on function public.go_authorization_snapshot(uuid) from public;
revoke all on function public.go_authorization_snapshot(uuid) from anon;
revoke all on function public.go_authorization_snapshot(uuid) from authenticated;
revoke all on function public.go_authorization_ack(uuid, bigint) from public;
revoke all on function public.go_authorization_ack(uuid, bigint) from anon;
revoke all on function public.go_authorization_ack(uuid, bigint) from authenticated;
grant execute on function public.go_authorization_snapshot(uuid) to service_role;
grant execute on function public.go_authorization_ack(uuid, bigint) to service_role;