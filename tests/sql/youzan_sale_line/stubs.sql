do $$ begin perform 1 from pg_roles where rolname='service_role'; if not found then create role service_role; end if; perform 1 from pg_roles where rolname='anon'; if not found then create role anon; end if; perform 1 from pg_roles where rolname='authenticated'; if not found then create role authenticated; end if; end $$;
create table public.inv_skus(id uuid primary key, stock_qty int not null default 0, inventory_policy text not null default 'tracked');
create table public.inventory_sale_events(id uuid primary key default gen_random_uuid(), source_channel text, source_shop_id uuid,
  source_order_id text, event_type text, event_version bigint, sku_id uuid, epc text, raw_payload jsonb, status text, error text,
  received_at timestamptz default now(), processed_at timestamptz, unique(source_channel, source_order_id, event_type));
-- 精简 commit_sale：同键幂等；无库存写 oversold；否则 -1 并写 processed（真实校验在生产函数内，包装层不绕开）。
create function public.commit_sale(p_sku_id uuid, p_source_channel text, p_source_order_id text, p_source_shop_id uuid default null,
  p_event_type text default 'sale', p_epc text default null, p_location_id uuid default null, p_raw_payload jsonb default '{}')
returns jsonb language plpgsql as $$ declare e public.inventory_sale_events%rowtype; q int; begin
  select * into e from public.inventory_sale_events where source_channel=p_source_channel and source_order_id=p_source_order_id and event_type=p_event_type;
  if found then return jsonb_build_object('ok', e.status='processed','idempotent',true,'status',e.status); end if;
  select stock_qty into q from public.inv_skus where id=p_sku_id for update;
  if coalesce(q,0) < 1 then insert into public.inventory_sale_events(source_channel,source_order_id,event_type,sku_id,raw_payload,status)
    values (p_source_channel,p_source_order_id,p_event_type,p_sku_id,p_raw_payload,'oversold'); return jsonb_build_object('ok',false,'error','oversold'); end if;
  update public.inv_skus set stock_qty=stock_qty-1 where id=p_sku_id;
  insert into public.inventory_sale_events(source_channel,source_order_id,event_type,sku_id,raw_payload,status)
    values (p_source_channel,p_source_order_id,p_event_type,p_sku_id,p_raw_payload,'processed');
  return jsonb_build_object('ok',true); end $$;
