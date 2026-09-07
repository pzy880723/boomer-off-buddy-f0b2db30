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
    ) as payload,
    roles.roles as role_list,
    locs.location_ids as location_ids,
    shops.shop_links as shop_links
    from roles, locs, shops
  ),
  expected as (
    select case
      -- 1) 没有真实 ERP 账号 / 停用 / 删除 → 墓碑
      when (base.payload->>'account_exists')::boolean is not true then 'revoked'
      when (base.payload->>'deleted')::boolean then 'revoked'
      when (base.payload->>'banned')::boolean then 'revoked'
      -- 2) 只有显式 revoked / rejected 才否决；identity 行缺失或 pending
      --    继续复用 GO 可信 canonical 绑定（现有总部账号无本地 identity 行）
      when coalesce(base.payload->>'identity_status','') in ('revoked','rejected') then 'revoked'
      -- 3) 没有任何 ERP 角色 → 无授权可下发
      when coalesce(array_length(base.role_list, 1), 0) = 0 then 'revoked'
      -- 4) 非 HQ：必须有门店授权且每个门店都有有效映射
      when not (base.role_list && array['super_admin','hq_operator'])
           and coalesce(array_length(base.location_ids, 1), 0) = 0 then 'revoked'
      when not (base.role_list && array['super_admin','hq_operator'])
           and exists (
             select 1 from unnest(base.location_ids) as lid
              where not exists (
                select 1 from jsonb_array_elements(base.shop_links) s
                 where (s->>'erp_location_id')::uuid = lid
              )
           ) then 'revoked'
      else 'active'
    end as expected_link_status
    from base
  )
  select jsonb_build_object(
    'payload', base.payload || jsonb_build_object(
      'expected_link_status', (select expected_link_status from expected)),
    'outbox', (select items from outbox),
    'now', (select now_ts from params)
  )
  from base;
$function$;

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

  with captured as (
    select (e->>'id')::uuid as id, (e->>'version')::bigint as version
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
revoke all on function public.go_authorization_ack(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.go_authorization_facts(uuid, text, integer) to service_role;
grant execute on function public.go_authorization_ack(uuid, bigint, text) to service_role;