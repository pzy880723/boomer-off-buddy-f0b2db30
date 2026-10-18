do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
CREATE TABLE public.inv_skus(id uuid PRIMARY KEY, name text);
CREATE TABLE public.commerce_customers(id uuid PRIMARY KEY, nickname text);
CREATE TABLE public.commerce_listings(id uuid PRIMARY KEY, location_id uuid, title text, price numeric, sku_id uuid);
CREATE TABLE public.commerce_orders(id uuid PRIMARY KEY, order_no text);
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
  to_location_id uuid, shipped_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.stocktakes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text DEFAULT 'ST', location_id uuid, status text, opened_at timestamptz DEFAULT now());
-- 与生产一致的客服触发器（只读导出）
CREATE FUNCTION public.tg_support_waiting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE public.support_conversations SET waiting_since = coalesce(waiting_since, NEW.created_at)
     WHERE id = NEW.conversation_id AND status <> 'closed';
  ELSIF NEW.sender_type = 'staff' AND NEW.internal = false AND NEW.delivery_status = 'sent' THEN
    UPDATE public.support_conversations SET waiting_since = NULL, escalated_at = NULL, escalation_reason = NULL
     WHERE id = NEW.conversation_id AND primary_agent_id = NEW.sender_user_id;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_support_waiting AFTER INSERT ON public.support_messages FOR EACH ROW EXECUTE FUNCTION public.tg_support_waiting();
