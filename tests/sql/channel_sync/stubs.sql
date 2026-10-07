do $$ begin perform 1 from pg_roles where rolname='service_role'; if not found then create role service_role; end if;
perform 1 from pg_roles where rolname='anon'; if not found then create role anon; end if;
perform 1 from pg_roles where rolname='authenticated'; if not found then create role authenticated; end if; end $$;
create table public.channel_sync_outbox(id uuid primary key default gen_random_uuid(), sku_id uuid, channel_listing_id uuid, channel text, shop_id uuid,
 action text, priority smallint default 5, inventory_version bigint default 0, target_stock int, dedupe_key text, status text default 'pending',
 attempts int default 0, max_attempts int default 8, next_run_at timestamptz default now(), worker_id text, claimed_at timestamptz,
 lease_expires_at timestamptz, request_payload jsonb default '{}', response_preview text, trace_id text, last_error text,
 created_at timestamptz default now(), updated_at timestamptz default now(), completed_at timestamptz);
create function public.claim_channel_sync_tasks(text,integer,integer) returns int language sql as 'select 1';
