-- rollback-only：go_authorization_facts.expected_link_status 与
-- TS expectedLinkStatus(buildAuthorizationSnapshot(facts)) 的对照用例。
-- 运行方式：整段包在 begin ... rollback 内，不改任何真实记录。
begin;

create temporary table t_expect(name text, got text, want text) on commit drop;

-- 固定 fixture id（合成 UUID，事务结束即回滚）
create temporary table t_ids as
select
  'aaaaaaa1-0000-4000-8000-000000000001'::uuid as hq_no_ident,
  'aaaaaaa1-0000-4000-8000-000000000002'::uuid as hq_pending,
  'aaaaaaa1-0000-4000-8000-000000000003'::uuid as hq_approved,
  'aaaaaaa1-0000-4000-8000-000000000004'::uuid as hq_revoked,
  'aaaaaaa1-0000-4000-8000-000000000005'::uuid as staff_no_role,
  'aaaaaaa1-0000-4000-8000-000000000006'::uuid as staff_no_loc,
  'aaaaaaa1-0000-4000-8000-000000000007'::uuid as staff_partial,
  'aaaaaaa1-0000-4000-8000-000000000008'::uuid as staff_full,
  'bbbbbbb1-0000-4000-8000-000000000001'::uuid as loc1,
  'bbbbbbb1-0000-4000-8000-000000000002'::uuid as loc2;

insert into auth.users (id, email)
select unnest(array[hq_no_ident, hq_pending, hq_approved, hq_revoked,
                    staff_no_role, staff_no_loc, staff_partial, staff_full]),
       'authz-fixture-' || gen_random_uuid() || '@example.test'
  from t_ids;

insert into inv_locations (id, kind, name, is_active)
select loc1, 'shop', 'FIXTURE 门店1', true from t_ids
union all
select loc2, 'shop', 'FIXTURE 门店2', true from t_ids;

insert into go_shop_location_links (go_project_ref, go_shop_id, location_id, status)
select 'narqwgwpqglathwtyevz', 'go-fixture-1', loc1, 'active' from t_ids
union all
select 'narqwgwpqglathwtyevz', 'go-fixture-2', loc2, 'active' from t_ids;

insert into user_roles (user_id, role)
select hq_no_ident, 'hq_operator'::app_role from t_ids
union all select hq_pending, 'hq_operator'::app_role from t_ids
union all select hq_approved, 'hq_operator'::app_role from t_ids
union all select hq_revoked, 'hq_operator'::app_role from t_ids
union all select staff_no_loc, 'store_staff'::app_role from t_ids
union all select staff_partial, 'store_staff'::app_role from t_ids
union all select staff_full, 'store_staff'::app_role from t_ids;

insert into user_location_perms (user_id, location_id)
select staff_partial, loc1 from t_ids
union all select staff_partial, loc2 from t_ids
union all select staff_full, loc1 from t_ids
union all select staff_full, loc2 from t_ids;

insert into go_identity_links (go_project_ref, go_user_id, erp_user_id, status)
select 'narqwgwpqglathwtyevz', 'go-u-pending', hq_pending, 'pending' from t_ids
union all select 'narqwgwpqglathwtyevz', 'go-u-approved', hq_approved, 'approved' from t_ids
union all select 'narqwgwpqglathwtyevz', 'go-u-revoked', hq_revoked, 'revoked' from t_ids;

-- 员工部分映射：把 loc2 的门店映射停用
update go_shop_location_links set status = 'inactive'
 where go_shop_id = 'go-fixture-2';

insert into t_expect
select 'HQ 无本地 identity 行', (go_authorization_facts(hq_no_ident, null, 2)->'payload'->>'expected_link_status'), 'active' from t_ids
union all select 'HQ identity=pending', (go_authorization_facts(hq_pending, null, 2)->'payload'->>'expected_link_status'), 'active' from t_ids
union all select 'HQ identity=approved', (go_authorization_facts(hq_approved, null, 2)->'payload'->>'expected_link_status'), 'active' from t_ids
union all select 'HQ 显式 revoked', (go_authorization_facts(hq_revoked, null, 2)->'payload'->>'expected_link_status'), 'revoked' from t_ids
union all select '无任何角色', (go_authorization_facts(staff_no_role, null, 2)->'payload'->>'expected_link_status'), 'revoked' from t_ids
union all select '员工无门店授权', (go_authorization_facts(staff_no_loc, null, 2)->'payload'->>'expected_link_status'), 'revoked' from t_ids
union all select '员工部分映射', (go_authorization_facts(staff_partial, null, 2)->'payload'->>'expected_link_status'), 'revoked' from t_ids
union all select '账号不存在', (go_authorization_facts('aaaaaaa1-0000-4000-8000-0000000000ff'::uuid, null, 2)->'payload'->>'expected_link_status'), 'revoked' from t_ids;

-- 恢复完整映射后再测 staff_full
update go_shop_location_links set status = 'active' where go_shop_id = 'go-fixture-2';
insert into t_expect
select '员工完整映射', (go_authorization_facts(staff_full, null, 2)->'payload'->>'expected_link_status'), 'active' from t_ids;

select name, got, want, (got = want) as pass from t_expect order by name;

rollback;
