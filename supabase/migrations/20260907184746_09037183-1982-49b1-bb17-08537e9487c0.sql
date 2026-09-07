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
  v_now timestamptz := clock_timestamp();
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

  select status into v_identity_status
    from public.go_identity_links
   where erp_user_id = p_erp_user_id
     and go_project_ref = v_project
     and (p_go_user_id is null or go_user_id = p_go_user_id)
   order by case when status = 'revoked' then 0 when status = 'rejected' then 1 else 2 end,
            updated_at desc
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
    'banned', v_exists and v_user.banned_until is not null and v_user.banned_until > v_now,
    'deleted', v_exists and v_user.deleted_at is not null,
    'roles', to_jsonb(v_roles),
    'location_ids', to_jsonb(v_locations),
    'identity_status', v_identity_status,
    'shop_links', v_shops,
    'permission_rev', p_permission_rev
  );
  v_hash := md5(v_payload::text);

  insert into public.go_authorization_snapshots as s
    (erp_user_id, go_project_ref, go_user_id, payload_hash, payload, version, computed_at, last_pulled_at)
  values (p_erp_user_id, v_project, p_go_user_id, v_hash, v_payload, 1, v_now, v_now)
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
           computed_at = v_now,
           last_pulled_at = v_now,
           updated_at = v_now
     where erp_user_id = p_erp_user_id
     returning * into v_row;
  else
    update public.go_authorization_snapshots
       set last_pulled_at = v_now,
           go_user_id = coalesce(p_go_user_id, go_user_id),
           updated_at = v_now
     where erp_user_id = p_erp_user_id
     returning * into v_row;
  end if;

  return v_payload
      || jsonb_build_object(
           'version', v_row.version,
           'generated_at', to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         );
end;
$$;

revoke all on function public.go_authorization_snapshot(uuid, text, integer) from public;
revoke all on function public.go_authorization_snapshot(uuid, text, integer) from anon;
revoke all on function public.go_authorization_snapshot(uuid, text, integer) from authenticated;
grant execute on function public.go_authorization_snapshot(uuid, text, integer) to service_role;