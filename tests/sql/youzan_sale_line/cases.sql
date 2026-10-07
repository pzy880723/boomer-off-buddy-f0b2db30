\set ON_ERROR_STOP 1
insert into inv_skus values ('00000000-0000-0000-0000-00000000000a', 5), ('00000000-0000-0000-0000-00000000000b', 5);
create function pg_temp.call(sku text, key text, legacy text, item bigint, u int) returns jsonb language sql as $$
  select public.commit_youzan_sale_line(sku::uuid,'youzan_branch_offline',key,legacy,null,null,
    jsonb_build_object('item_id',item,'unit_index',u)) $$;
-- 1 行重排：旧事件 T1#0#0 是 A 品；新顺序 A 在下标 1，传入 legacy=T1#1#0（不存在）→ 必须识别旧事件，不再扣
insert into inventory_sale_events(source_channel,source_order_id,event_type,sku_id,raw_payload,status)
  values ('youzan_branch_offline','T1#0#0','paid','00000000-0000-0000-0000-00000000000a','{"item_id":11,"unit_index":0}','processed');
do $$ declare r jsonb; begin
  r := pg_temp.call('00000000-0000-0000-0000-00000000000a','T1#oid:A#0','T1#1#0',11,0);
  if (r->>'ok')::bool is not true or (r->>'idempotent')::bool is not true then raise exception 'FAIL reorder %', r; end if;
  if (select stock_qty from inv_skus where id='00000000-0000-0000-0000-00000000000a') <> 5 then raise exception 'FAIL reorder deducted'; end if;
  raise notice 'PASS reordered legacy event recognised, no double deduction'; end $$;
-- 2 歧义：同单同 SKU 同单位有两条旧事件 → 拒绝，不扣
insert into inventory_sale_events(source_channel,source_order_id,event_type,sku_id,raw_payload,status) values
  ('youzan_branch_offline','T2#0#0','paid','00000000-0000-0000-0000-00000000000b','{"item_id":22,"unit_index":0}','processed'),
  ('youzan_branch_offline','T2#1#0','paid','00000000-0000-0000-0000-00000000000b','{"item_id":22,"unit_index":0}','processed');
do $$ declare r jsonb; begin
  r := pg_temp.call('00000000-0000-0000-0000-00000000000b','T2#oid:X#0','T2#2#0',22,0);
  if (r->>'ok')::bool is not false or r->>'error' <> 'ambiguous_legacy' then raise exception 'FAIL ambiguous %', r; end if;
  if (select stock_qty from inv_skus where id='00000000-0000-0000-0000-00000000000b') <> 5 then raise exception 'FAIL ambiguous deducted'; end if;
  raise notice 'PASS ambiguous legacy rejected without deduction'; end $$;
-- 3 失败可重试：oversold 事件后补货，再次调用应真实扣减，旧失败行留痕
update inv_skus set stock_qty=0 where id='00000000-0000-0000-0000-00000000000a';
do $$ declare r jsonb; begin
  r := pg_temp.call('00000000-0000-0000-0000-00000000000a','T3#oid:Z#0',null,33,0);
  if (r->>'ok')::bool then raise exception 'FAIL expected oversold'; end if;
  update inv_skus set stock_qty=1 where id='00000000-0000-0000-0000-00000000000a';
  r := pg_temp.call('00000000-0000-0000-0000-00000000000a','T3#oid:Z#0',null,33,0);
  if (r->>'ok')::bool is not true then raise exception 'FAIL retry %', r; end if;
  if (select stock_qty from inv_skus where id='00000000-0000-0000-0000-00000000000a') <> 0 then raise exception 'FAIL retry qty'; end if;
  if (select count(*) from inventory_sale_events where source_order_id like 'T3#oid:Z#0~retry%' and status='oversold') <> 1 then raise exception 'FAIL retry audit'; end if;
  r := pg_temp.call('00000000-0000-0000-0000-00000000000a','T3#oid:Z#0',null,33,0);
  if (r->>'idempotent')::bool is not true then raise exception 'FAIL replay'; end if;
  raise notice 'PASS failed event retried once real stock exists; processed replay idempotent'; end $$;
-- 4 精确旧键仍幂等；未处理(oversold)旧键不算已扣
insert into inventory_sale_events(source_channel,source_order_id,event_type,sku_id,raw_payload,status)
  values ('youzan_branch_offline','T4#0#0','paid','00000000-0000-0000-0000-00000000000b','{"item_id":44,"unit_index":0}','oversold');
do $$ declare r jsonb; begin
  r := pg_temp.call('00000000-0000-0000-0000-00000000000b','T4#oid:Q#0','T4#0#0',44,0);
  if (r->>'ok')::bool is not true or (r->>'idempotent')::bool then raise exception 'FAIL oversold legacy should not count %', r; end if;
  raise notice 'PASS non-processed legacy event does not count as done'; end $$;
