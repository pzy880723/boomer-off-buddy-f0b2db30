do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
CREATE TABLE public.inv_skus(id uuid PRIMARY KEY, name text);
CREATE TABLE public.commerce_customers(id uuid PRIMARY KEY, nickname text);
CREATE TABLE public.commerce_listings(id uuid PRIMARY KEY, location_id uuid, title text, price numeric, sku_id uuid);
CREATE TABLE public.commerce_orders(id uuid PRIMARY KEY, order_no text, order_status text DEFAULT 'confirmed', payment_status text DEFAULT 'paid', fulfillment_method text DEFAULT 'express');
CREATE TABLE public.product_measurement_tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid, listing_id uuid, location_id uuid,
  status text DEFAULT 'pending', created_at timestamptz DEFAULT now());
CREATE TABLE public.product_measurement_requesters(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid, customer_id uuid,
  notified_at timestamptz, created_at timestamptz DEFAULT now(), UNIQUE(task_id, customer_id));
CREATE TABLE public.support_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, location_id uuid, customer_id uuid,
  status text DEFAULT 'open', context_key text, context jsonb, channel text DEFAULT 'native', topic text DEFAULT 'general',
  primary_agent_id uuid, waiting_since timestamptz, escalated_at timestamptz, escalation_reason text,
  last_message_at timestamptz, last_message_preview text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX uq_support_active_customer_context ON public.support_conversations(customer_id, context_key)
  WHERE context_key IS NOT NULL AND status IN ('open','pending');
CREATE TABLE public.support_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES support_conversations(id),
  sender_type text NOT NULL, sender_user_id uuid, sender_customer_id uuid, sender_name text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  internal boolean NOT NULL DEFAULT false, client_op_id text, created_at timestamptz NOT NULL DEFAULT now(), delivery_status text NOT NULL DEFAULT 'sent');
CREATE UNIQUE INDEX uq_support_messages_client_op ON public.support_messages(conversation_id, client_op_id) WHERE client_op_id IS NOT NULL;
CREATE TABLE public.fulfillments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text DEFAULT 'FF', order_id uuid, location_id uuid,
  status text DEFAULT 'allocated', created_at timestamptz DEFAULT now());
CREATE TABLE public.stock_transfers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text DEFAULT 'TR', status text, qty int DEFAULT 1,
  from_location_id uuid, to_location_id uuid, shipped_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.inv_locations(id uuid PRIMARY KEY, shop_id uuid);
CREATE TABLE public.commerce_after_sales(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, status text, after_sale_no text, created_at timestamptz DEFAULT now());
CREATE TABLE public.youzan_stock_sync_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, status text, created_at timestamptz DEFAULT now());
CREATE TABLE public.channel_sync_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, status text, created_at timestamptz DEFAULT now());
CREATE TABLE public.fulfillment_shortages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fulfillment_id uuid, status text, created_at timestamptz DEFAULT now());
CREATE TABLE public.stocktakes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text DEFAULT 'ST', location_id uuid, status text, opened_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
-- Production trigger definitions loaded verbatim by run.sh.
