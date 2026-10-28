-- 多渠道销售隔离测试桩：只含 0117 依赖的列，空库造数，永不连生产。
do $$ begin
  perform 1 from pg_roles where rolname='service_role'; if not found then create role service_role; end if;
  perform 1 from pg_roles where rolname='anon'; if not found then create role anon; end if;
  perform 1 from pg_roles where rolname='authenticated'; if not found then create role authenticated; end if;
end $$;
create table public.inv_skus(id uuid primary key, sales_state text not null default 'active', is_display boolean default true, inventory_version bigint default 1);
create table public.inv_locations(id uuid primary key, kind text, shop_id uuid, is_active boolean default true);
create table public.inv_stocks(sku_id uuid, location_id uuid, qty int, primary key(sku_id, location_id));
create table public.commerce_listings(id uuid primary key default gen_random_uuid(), sku_id uuid, location_id uuid, status text, unique(sku_id, location_id));
create table public.youzan_shops(id uuid primary key, access_token text, expires_at timestamptz);
create table public.sku_channel_listings(id uuid primary key default gen_random_uuid(), sku_id uuid, channel text, shop_id uuid, external_item_id text, listing_status text, updated_at timestamptz default now());
create table public.channel_sync_outbox(id uuid primary key default gen_random_uuid(), sku_id uuid, channel_listing_id uuid, channel text, shop_id uuid,
 action text, priority smallint default 5, inventory_version bigint default 0, target_stock int, dedupe_key text unique, status text default 'pending',
 attempts int default 0, max_attempts int default 8, next_run_at timestamptz default now(), request_payload jsonb default '{}', last_error text,
 created_at timestamptz default now(), updated_at timestamptz default now(), completed_at timestamptz);
create table public.user_roles(user_id uuid, role text);
create table public.user_location_perms(user_id uuid, location_id uuid);
create table public.commerce_orders(id uuid primary key default gen_random_uuid(), source_channel text default 'storefront', fulfillment_method text default 'express');
create table public.commerce_order_items(id uuid primary key default gen_random_uuid(), order_id uuid, sku_id uuid, location_id uuid);
-- 原下单函数桩：插入订单+订单行（真实函数同样在同一事务内插入订单行）。
create function public.commerce_create_ordinary_order(p_customer_id uuid, p_idempotency_key text, p_items jsonb, p_recipient_name text, p_recipient_phone text, p_shipping_address jsonb, p_courier_provider text, p_courier_service_code text, p_courier_service_name text, p_shipping_fee numeric, p_quote_snapshot jsonb, p_customer_note text, p_merchant_id text, p_app_id text, p_owned_location_ids uuid[])
returns jsonb language plpgsql as $$ declare o uuid; it jsonb; begin
  insert into commerce_orders default values returning id into o;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into commerce_order_items(order_id, sku_id, location_id) values (o, (it->>'sku_id')::uuid, (it->>'location_id')::uuid);
  end loop; return jsonb_build_object('id', o, 'fulfillment_method', 'express'); end $$;
create function public.commerce_create_ordinary_pickup_order(p_customer_id uuid, p_idempotency_key text, p_items jsonb, p_recipient_name text, p_recipient_phone text, p_quote_snapshot jsonb, p_customer_note text, p_merchant_id text, p_app_id text, p_owned_location_ids uuid[])
returns jsonb language sql as $$ select '{}'::jsonb $$;
create function public.commerce_create_ordinary_flash_order(p_customer_id uuid, p_idempotency_key text, p_items jsonb, p_recipient_name text, p_recipient_phone text, p_shipping_address jsonb, p_quote_snapshot jsonb, p_customer_note text, p_merchant_id text, p_app_id text, p_owned_location_ids uuid[])
returns jsonb language sql as $$ select '{}'::jsonb $$;
create function public.commerce_create_order_v2(p_user_id uuid, p_idempotency_key text, p_items jsonb, p_recipient_name text, p_recipient_phone text, p_shipping_address jsonb, p_courier_provider text, p_courier_service_code text, p_courier_service_name text, p_shipping_fee numeric, p_quote_snapshot jsonb, p_customer_note text)
returns commerce_orders language sql as $$ select * from commerce_orders limit 1 $$;
