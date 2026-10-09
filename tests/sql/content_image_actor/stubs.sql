-- Minimal structure for the content-image actor binding test (no business data).
do $$ begin create role anon; exception when duplicate_object then null; end $$; do $$ begin create role authenticated; exception when duplicate_object then null; end $$; do $$ begin create role service_role; exception when duplicate_object then null; end $$;
create schema storage; create table storage.objects(bucket_id text, name text);
create table public.inv_skus(id uuid primary key, status text, is_custom_price boolean, kind text, image_paths text[]);
create table public.inv_stocks(sku_id uuid, location_id uuid);
create table public.inv_product_content(sku_id uuid primary key, version int, draft_blocks jsonb, published_blocks jsonb,
  published_version int, updated_by uuid, updated_at timestamptz default now());
create table public.inv_product_content_ops(device_id uuid, client_op_id text, user_id uuid, location_id uuid, sku_id uuid,
  request jsonb, response jsonb, primary key(device_id, client_op_id));
create table public.inv_product_content_image_jobs(id uuid primary key default gen_random_uuid(), sku_id uuid, block_id text,
  source_path text, target_path text, status text not null default 'queued', attempts int not null default 0, claim_token uuid,
  lease_until timestamptz, last_error text, next_run_at timestamptz default now(), created_at timestamptz default now(),
  updated_at timestamptz default now(), ai_actor_user_id uuid, ai_policy_version text, unique(sku_id, block_id, source_path));
create function public.handheld_item_actor(u uuid, l uuid) returns jsonb language sql as $$ select '{"hq":true}'::jsonb $$;
create function public.handheld_item_fail(c text, m text) returns void language plpgsql as $$ begin raise exception '%: %', c, m; end $$;
create function public.product_content_validate_blocks(b jsonb) returns void language sql as $$ select $$;
