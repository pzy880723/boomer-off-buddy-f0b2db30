-- 手持待办/通知回归的隔离库结构 stubs（仅结构，不连生产库）。
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;

CREATE TABLE public.inv_locations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shop_id uuid, is_active boolean DEFAULT true);
CREATE TABLE public.inv_skus(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, image_paths jsonb, image_url text);
CREATE TABLE public.product_measurement_tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid, listing_id uuid, location_id uuid,
  status text DEFAULT 'pending', created_at timestamptz DEFAULT now());
CREATE TABLE public.product_measurement_requesters(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid, customer_id uuid,
  conversation_id uuid, notified_at timestamptz, created_at timestamptz DEFAULT now(), UNIQUE(task_id, customer_id));
CREATE TABLE public.support_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, location_id uuid, customer_id uuid,
  status text DEFAULT 'open', context_key text, context jsonb, channel text DEFAULT 'native', topic text DEFAULT 'general',
  primary_agent_id uuid, waiting_since timestamptz, escalated_at timestamptz, escalation_reason text,
  last_message_at timestamptz, last_message_preview text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.support_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, sender_type text DEFAULT 'customer',
  sender_user_id uuid, sender_customer_id uuid, sender_name text DEFAULT '', body text DEFAULT '', internal boolean DEFAULT false,
  client_op_id text, measurement_task_id uuid, card_kind text, delivery_status text DEFAULT 'sent', created_at timestamptz DEFAULT now());
CREATE TABLE public.inv_handheld_notifications(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid, location_id uuid REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('stocktake_assigned','transfer_incoming','youzan_sync_failed','unclaimed_epc_pending','system','order_paid','measurement_requested')),
  title text, payload jsonb NOT NULL DEFAULT '{}', ts timestamptz NOT NULL DEFAULT now(), user_id uuid,
  audience text NOT NULL DEFAULT 'location', action_status text, ref_type text, ref_id uuid);
CREATE TABLE public.youzan_stock_sync_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid, shop_id uuid, location_id uuid,
  status text, attempts int DEFAULT 0, last_error text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.channel_sync_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid, shop_id uuid,
  status text, attempts int DEFAULT 0, last_error text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.commerce_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_no text, order_status text DEFAULT 'confirmed',
  payment_status text DEFAULT 'paid', fulfillment_method text DEFAULT 'express');
CREATE TABLE public.fulfillments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text DEFAULT 'FF', order_id uuid, location_id uuid,
  status text DEFAULT 'allocated', created_at timestamptz DEFAULT now());
CREATE TABLE public.stock_transfers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text DEFAULT 'TR', status text, qty int DEFAULT 1,
  from_location_id uuid, to_location_id uuid, shipped_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.stocktakes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text DEFAULT 'ST', location_id uuid, status text,
  opened_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.commerce_after_sales(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, status text, after_sale_no text,
  created_at timestamptz DEFAULT now());

-- 0097 会 ENABLE 的两个生产触发器：隔离库用空触发器占位（本回归不覆盖会话卡片写入链路）。
CREATE OR REPLACE FUNCTION public.tg_stub_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER trg_measurement_requester_support AFTER INSERT ON public.product_measurement_requesters FOR EACH ROW EXECUTE FUNCTION public.tg_stub_noop();
CREATE TRIGGER trg_measurement_task_completed_support AFTER UPDATE ON public.product_measurement_tasks FOR EACH ROW EXECUTE FUNCTION public.tg_stub_noop();

-- work_items 聚合需要的支撑函数（语义同生产：waiting_since 非空，或最新非内部消息来自顾客，即待回复）。
CREATE OR REPLACE FUNCTION public.support_needs_reply(p_conversation_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public' AS
$$ SELECT EXISTS(SELECT 1 FROM public.support_conversations c WHERE c.id = p_conversation_id AND c.waiting_since IS NOT NULL)
       OR EXISTS(SELECT 1 FROM public.support_messages m
                  WHERE m.conversation_id = p_conversation_id AND m.sender_type = 'customer' AND NOT m.internal) $$;
