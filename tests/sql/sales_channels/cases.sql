\set ON_ERROR_STOP 1
-- 造数：门店A(有赞shop SA)、门店B、仓库W；店长M只授权A；总部H；店员S无管理角色。
insert into youzan_shops values ('5a000000-0000-0000-0000-000000000001','tok',now()+interval '30 days');
insert into inv_locations values ('a0000000-0000-0000-0000-000000000001','shop','5a000000-0000-0000-0000-000000000001',true),
 ('b0000000-0000-0000-0000-000000000001','shop',null,true),('c0000000-0000-0000-0000-000000000001','warehouse',null,true);
insert into inv_skus(id, sales_state) values ('10000000-0000-0000-0000-000000000001','active'),('10000000-0000-0000-0000-000000000002','active'),
 ('10000000-0000-0000-0000-000000000003','sold'),('10000000-0000-0000-0000-000000000004','active');
insert into inv_stocks values ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001',1),
 ('10000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000001',1),
 ('10000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000001',0),
 ('10000000-0000-0000-0000-000000000004','b0000000-0000-0000-0000-000000000001',1);
insert into commerce_listings(sku_id, location_id, status) values ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','published'),
 ('10000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000001','published'),
 ('10000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000001','sold');
insert into sku_channel_listings(id, sku_id, channel, shop_id, external_item_id, listing_status) values
 ('e0000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','youzan_branch_offline','5a000000-0000-0000-0000-000000000001','111','published');
insert into user_roles values ('a1000000-0000-0000-0000-00000000000a','store_manager'),('a1000000-0000-0000-0000-00000000000b','hq_operator'),('a1000000-0000-0000-0000-00000000000c','store_staff');
insert into user_location_perms values ('a1000000-0000-0000-0000-00000000000a','a0000000-0000-0000-0000-000000000001'),('a1000000-0000-0000-0000-00000000000c','a0000000-0000-0000-0000-000000000001');

do $$ declare r jsonb; n int; M uuid:='a1000000-0000-0000-0000-00000000000a'; A uuid:='a0000000-0000-0000-0000-000000000001';
  B uuid:='b0000000-0000-0000-0000-000000000001'; S1 uuid:='10000000-0000-0000-0000-000000000001'; op uuid:=gen_random_uuid();
begin
  -- 无意图 = 旧行为
  if not sales_channel_allowed(S1, A, 'miniapp') or not sales_channel_allowed(S1, A, 'unknown') then raise exception 'FAIL default'; end if;
  raise notice 'PASS no intent keeps legacy visibility';

  -- 角色/门店
  begin perform sales_channel_apply('a1000000-0000-0000-0000-00000000000c', A, gen_random_uuid(), 'single', 'h', '[{"sku_id":"10000000-0000-0000-0000-000000000001","channel":"miniapp","enabled":false,"expected_version":0}]'); raise exception 'FAIL staff';
  exception when others then if sqlerrm <> 'role_forbidden' then raise exception 'FAIL staff %', sqlerrm; end if; end;
  begin perform sales_channel_apply(M, B, gen_random_uuid(), 'single', 'h', '[{"sku_id":"10000000-0000-0000-0000-000000000004","channel":"miniapp","enabled":false,"expected_version":0}]'); raise exception 'FAIL other store';
  exception when others then if sqlerrm <> 'location_forbidden' then raise exception 'FAIL other store %', sqlerrm; end if; end;
  begin perform sales_channel_apply(M, 'c0000000-0000-0000-0000-000000000001', gen_random_uuid(), 'single', 'h', '[{"sku_id":"10000000-0000-0000-0000-000000000001","channel":"miniapp","enabled":false,"expected_version":0}]'); raise exception 'FAIL warehouse';
  exception when others then if sqlerrm <> 'location_forbidden' then raise exception 'FAIL warehouse %', sqlerrm; end if; end;
  raise notice 'PASS role, store and shop-kind enforced';

  -- 别店商品 / 版本冲突 / 关闭小程序
  r := sales_channel_apply(M, A, op, 'single', 'h1', '[{"sku_id":"10000000-0000-0000-0000-000000000004","channel":"miniapp","enabled":false,"expected_version":0},
     {"sku_id":"10000000-0000-0000-0000-000000000001","channel":"miniapp","enabled":false,"expected_version":5},
     {"sku_id":"10000000-0000-0000-0000-000000000001","channel":"app","enabled":false,"expected_version":0}]');
  if (select count(*) from jsonb_array_elements(r->'results') e where e->>'reason'='not_in_store') <> 1 then raise exception 'FAIL not_in_store %', r; end if;
  if (select count(*) from jsonb_array_elements(r->'results') e where e->>'reason'='version_conflict') <> 1 then raise exception 'FAIL version %', r; end if;
  if sales_channel_allowed(S1, A, 'app') is not false or sales_channel_allowed(S1, A, 'miniapp') is not true then raise exception 'FAIL per channel'; end if;
  if sales_channel_allowed(S1, A, 'unknown') then raise exception 'FAIL unknown conservative'; end if;
  raise notice 'PASS per-item ownership/version; app-only disable; unknown source conservative';

  -- 幂等重放 & op 绑定
  if (sales_channel_apply(M, A, op, 'single', 'h1', '[{}]')->>'replayed')::boolean is not true then raise exception 'FAIL replay'; end if;
  begin perform sales_channel_apply(M, A, op, 'single', 'other', '[{}]'); raise exception 'FAIL op reuse';
  exception when others then if sqlerrm <> 'op_id_conflict' then raise exception 'FAIL op reuse %', sqlerrm; end if; end;
  begin perform sales_channel_apply('a1000000-0000-0000-0000-00000000000b', A, op, 'single', 'h1', '[{}]'); raise exception 'FAIL op actor';
  exception when others then if sqlerrm <> 'op_id_conflict' then raise exception 'FAIL op actor %', sqlerrm; end if; end;
  if (select version from sku_sales_channel_intents where sku_id=S1 and channel='app') <> 1 then raise exception 'FAIL double apply'; end if;
  raise notice 'PASS op_id replay returns original; bound to actor+store+payload';

  -- 已售不得重开；有赞关闭入队 delist（不改库存）
  r := sales_channel_apply(M, A, gen_random_uuid(), 'single', 'h2', '[{"sku_id":"10000000-0000-0000-0000-000000000003","channel":"miniapp","enabled":true,"expected_version":0},
     {"sku_id":"10000000-0000-0000-0000-000000000001","channel":"youzan","enabled":false,"expected_version":0},
     {"sku_id":"10000000-0000-0000-0000-000000000002","channel":"youzan","enabled":false,"expected_version":0}]');
  if (select count(*) from jsonb_array_elements(r->'results') e where e->>'reason'='sold_locked') <> 1 then raise exception 'FAIL sold %', r; end if;
  if (select count(*) from jsonb_array_elements(r->'results') e where e->>'reason'='youzan_not_mapped') <> 1 then raise exception 'FAIL unmapped %', r; end if;
  select count(*) into n from channel_sync_outbox where action='delist' and request_payload->>'source'='sales_channel_intent' and (request_payload->>'intent_version')::int=1;
  if n <> 1 then raise exception 'FAIL delist queued %', n; end if;
  if (select qty from inv_stocks where sku_id=S1 and location_id=A) <> 1 then raise exception 'FAIL stock touched'; end if;
  raise notice 'PASS sold locked; unmapped youzan rejected; youzan disable queued without stock writes';

  -- 重新开启：旧任务作废，新任务 shelf
  perform sales_channel_apply(M, A, gen_random_uuid(), 'single', 'h3', '[{"sku_id":"10000000-0000-0000-0000-000000000001","channel":"youzan","enabled":true,"expected_version":1}]');
  if (select status from channel_sync_outbox where dedupe_key like 'salesch:%:1') <> 'superseded' then raise exception 'FAIL old not superseded'; end if;
  -- 平台仍 published → 无需新任务
  if exists (select 1 from channel_sync_outbox where dedupe_key like 'salesch:%:2') then raise exception 'FAIL redundant shelf'; end if;
  raise notice 'PASS newer intent supersedes pending task; no redundant platform write';

  -- 上限
  begin perform sales_channel_apply(M, A, gen_random_uuid(), 'batch', 'h', (select jsonb_agg(jsonb_build_object('sku_id', gen_random_uuid(), 'channel','app','enabled',false,'expected_version',0)) from generate_series(1,101)));
    raise exception 'FAIL limit';
  exception when others then if sqlerrm <> 'batch_limit' then raise exception 'FAIL limit %', sqlerrm; end if; end;
  raise notice 'PASS batch limit 100 SKUs';
end $$;

-- 快照批量：绑定 actor/门店/有效期，单次消费，重试同 op 原结果
do $$ declare t uuid; op uuid := gen_random_uuid(); r jsonb; M uuid:='a1000000-0000-0000-0000-00000000000a'; A uuid:='a0000000-0000-0000-0000-000000000001'; begin
  insert into sku_sales_channel_previews(actor_user_id, location_id, add_channels, remove_channels, items, expires_at)
  values (M, A, '{}', '{miniapp}', '[{"sku_id":"10000000-0000-0000-0000-000000000002","changes":{"miniapp":{"enabled":false,"expected_version":0}}}]', now()+interval '10 minutes') returning token into t;
  begin perform sales_channel_apply_preview('a1000000-0000-0000-0000-00000000000b', A, op, t); raise exception 'FAIL preview actor';
  exception when others then if sqlerrm <> 'preview_invalid' then raise exception 'FAIL preview actor %', sqlerrm; end if; end;
  r := sales_channel_apply_preview(M, A, op, t);
  if (r->'results'->0->>'success')::boolean is not true then raise exception 'FAIL preview apply %', r; end if;
  if (sales_channel_apply_preview(M, A, op, t)->>'replayed')::boolean is not true then raise exception 'FAIL preview replay'; end if;
  begin perform sales_channel_apply_preview(M, A, gen_random_uuid(), t); raise exception 'FAIL reuse token';
  exception when others then if sqlerrm <> 'preview_consumed' then raise exception 'FAIL reuse %', sqlerrm; end if; end;
  if exists (select 1 from sku_sales_channel_intents where sku_id='10000000-0000-0000-0000-000000000001' and channel='miniapp') then raise exception 'FAIL unselected touched'; end if;
  update sku_sales_channel_previews set consumed_op_id=null, expires_at=now()-interval '1 second' where token=t;
  begin perform sales_channel_apply_preview(M, A, gen_random_uuid(), t); raise exception 'FAIL expired';
  exception when others then if sqlerrm <> 'preview_expired' then raise exception 'FAIL expired %', sqlerrm; end if; end;
  raise notice 'PASS preview bound to actor/store/expiry, single-use, replay, unselected untouched';
end $$;

-- 下单原子拦截：包装函数设置渠道；直接调用（未知来源）保守拦截；POS 不受影响
do $$ declare A uuid:='a0000000-0000-0000-0000-000000000001'; o uuid; begin
  -- S1: app 关闭；S2: miniapp 关闭
  perform commerce_create_order_in_channel('miniapp', 'commerce_create_ordinary_order', jsonb_build_object('p_items', '[{"sku_id":"10000000-0000-0000-0000-000000000001","location_id":"a0000000-0000-0000-0000-000000000001"}]'::jsonb, 'p_owned_location_ids', '[]'::jsonb));
  begin perform commerce_create_order_in_channel('app', 'commerce_create_ordinary_order', jsonb_build_object('p_items', '[{"sku_id":"10000000-0000-0000-0000-000000000001","location_id":"a0000000-0000-0000-0000-000000000001"}]'::jsonb));
    raise exception 'FAIL app order allowed';
  exception when others then if sqlerrm <> 'sales channel disabled' then raise exception 'FAIL app %', sqlerrm; end if; end;
  begin perform commerce_create_ordinary_order(null,null,'[{"sku_id":"10000000-0000-0000-0000-000000000001","location_id":"a0000000-0000-0000-0000-000000000001"}]',null,null,null,null,null,null,null,null,null,null,null,null);
    raise exception 'FAIL direct call allowed';
  exception when others then if sqlerrm <> 'sales channel disabled' then raise exception 'FAIL direct %', sqlerrm; end if; end;
  if (select count(*) from commerce_order_items where sku_id='10000000-0000-0000-0000-000000000001') <> 1 then raise exception 'FAIL rolled back rows'; end if;
  insert into commerce_orders(source_channel) values ('pos') returning id into o;
  insert into commerce_order_items(order_id, sku_id, location_id) values (o, '10000000-0000-0000-0000-000000000001', A);
  begin perform commerce_create_order_in_channel('web', 'commerce_create_ordinary_order', '{}'); raise exception 'FAIL bad channel';
  exception when others then if sqlerrm <> 'invalid sales channel' then raise exception 'FAIL bad channel %', sqlerrm; end if; end;
  raise notice 'PASS order insert enforces channel atomically; direct/unknown callers conservative; POS unaffected';
end $$;

select bool_or(has_function_privilege(r, f, 'execute')) as leak from unnest(array['anon','authenticated']) r,
 unnest(array['sales_channel_apply(uuid,uuid,uuid,text,text,jsonb)','sales_channel_apply_preview(uuid,uuid,uuid,uuid)','commerce_create_order_in_channel(text,text,jsonb)','sales_channel_allowed(uuid,uuid,text)']) f \gset
\if :leak
\echo FAIL client roles can execute
\else
\echo PASS client roles cannot execute RPCs
\endif
select bool_or(has_table_privilege(r, t, 'select')) as tleak from unnest(array['anon','authenticated']) r,
 unnest(array['sku_sales_channel_intents','sku_sales_channel_ops','sku_sales_channel_previews']) t \gset
\if :tleak
\echo FAIL client roles can read tables
\else
\echo PASS tables service_role only
\endif
