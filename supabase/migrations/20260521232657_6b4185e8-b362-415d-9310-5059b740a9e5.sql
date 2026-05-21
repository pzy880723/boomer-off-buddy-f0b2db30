-- 有赞订单流水
create table public.youzan_orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.youzan_shops(id) on delete cascade,
  kdt_id bigint not null,
  tid text not null,
  status text,
  pay_type int,
  buyer_nick text,
  total_fee numeric,
  payment numeric,
  num int,
  pay_time timestamptz,
  created_time timestamptz,
  raw jsonb,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kdt_id, tid)
);
create index idx_youzan_orders_shop_paytime on public.youzan_orders (shop_id, pay_time desc);
create index idx_youzan_orders_paytime on public.youzan_orders (pay_time desc);

alter table public.youzan_orders enable row level security;
create policy open_select_youzan_orders on public.youzan_orders for select using (true);
create policy open_insert_youzan_orders on public.youzan_orders for insert with check (true);
create policy open_update_youzan_orders on public.youzan_orders for update using (true);
create policy open_delete_youzan_orders on public.youzan_orders for delete using (true);

create trigger trg_youzan_orders_updated
  before update on public.youzan_orders
  for each row execute function public.tg_set_updated_at();

-- 有赞商品 + 库存
create table public.youzan_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.youzan_shops(id) on delete cascade,
  kdt_id bigint not null,
  item_id bigint not null,
  title text,
  price numeric,
  stock_qty int not null default 0,
  is_listed boolean not null default true,
  pic_url text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kdt_id, item_id)
);
create index idx_youzan_items_shop on public.youzan_items (shop_id);

alter table public.youzan_items enable row level security;
create policy open_select_youzan_items on public.youzan_items for select using (true);
create policy open_insert_youzan_items on public.youzan_items for insert with check (true);
create policy open_update_youzan_items on public.youzan_items for update using (true);
create policy open_delete_youzan_items on public.youzan_items for delete using (true);

create trigger trg_youzan_items_updated
  before update on public.youzan_items
  for each row execute function public.tg_set_updated_at();