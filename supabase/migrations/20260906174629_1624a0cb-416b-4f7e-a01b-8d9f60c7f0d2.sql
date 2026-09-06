-- ============ A. 统一消息 ============
ALTER TABLE public.inv_handheld_notifications
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'location',
  ADD COLUMN IF NOT EXISTS action_status text,
  ADD COLUMN IF NOT EXISTS ref_type text,
  ADD COLUMN IF NOT EXISTS ref_id uuid;

CREATE INDEX IF NOT EXISTS idx_handheld_notifications_ts ON public.inv_handheld_notifications(ts DESC);
CREATE INDEX IF NOT EXISTS idx_handheld_notifications_location ON public.inv_handheld_notifications(location_id);
CREATE INDEX IF NOT EXISTS idx_handheld_notifications_user ON public.inv_handheld_notifications(user_id);

CREATE TABLE IF NOT EXISTS public.handheld_notification_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES public.inv_handheld_notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, user_id)
);
GRANT ALL ON public.handheld_notification_reads TO service_role;
ALTER TABLE public.handheld_notification_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notification reads are backend only"
  ON public.handheld_notification_reads FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============ B. 客服会话 ============
CREATE TABLE IF NOT EXISTS public.support_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  scope text NOT NULL DEFAULT 'location' CHECK (scope IN ('hq', 'location')),
  location_id uuid REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  display_name text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, location_id)
);
GRANT ALL ON public.support_agents TO service_role;
ALTER TABLE public.support_agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "support agents are backend only"
  ON public.support_agents FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.support_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text,
  location_id uuid REFERENCES public.inv_locations(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.commerce_orders(id) ON DELETE SET NULL,
  topic text NOT NULL DEFAULT 'general',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
  last_message_at timestamptz,
  last_message_preview text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.support_conversations TO service_role;
ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "support conversations are backend only"
  ON public.support_conversations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_support_conversations_location ON public.support_conversations(location_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_conversations_customer ON public.support_conversations(customer_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.support_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  participant_role text NOT NULL DEFAULT 'store_staff' CHECK (participant_role IN ('store_staff', 'hq_agent')),
  display_name text,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  UNIQUE (conversation_id, user_id)
);
GRANT ALL ON public.support_participants TO service_role;
ALTER TABLE public.support_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "support participants are backend only"
  ON public.support_participants FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('customer', 'staff', 'system')),
  sender_user_id uuid,
  sender_customer_id uuid REFERENCES public.commerce_customers(id) ON DELETE SET NULL,
  sender_name text NOT NULL,
  body text NOT NULL,
  internal boolean NOT NULL DEFAULT false,
  client_op_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_messages_internal_staff_only CHECK (internal = false OR sender_type = 'staff')
);
GRANT ALL ON public.support_messages TO service_role;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "support messages are backend only"
  ON public.support_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_messages_client_op
  ON public.support_messages(conversation_id, client_op_id) WHERE client_op_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON public.support_messages(conversation_id, created_at);

CREATE OR REPLACE FUNCTION public.tg_support_conversation_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.support_conversations
     SET last_message_at = NEW.created_at,
         last_message_preview = CASE WHEN NEW.internal THEN NULL ELSE left(NEW.body, 120) END,
         updated_at = now()
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_support_conversation_touch ON public.support_messages;
CREATE TRIGGER trg_support_conversation_touch
AFTER INSERT ON public.support_messages
FOR EACH ROW EXECUTE FUNCTION public.tg_support_conversation_touch();

-- ============ C. 缺货申报与客户确认 ============
CREATE TABLE IF NOT EXISTS public.fulfillment_shortages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL REFERENCES public.fulfillments(id) ON DELETE CASCADE,
  fulfillment_item_id uuid NOT NULL REFERENCES public.fulfillment_items(id) ON DELETE CASCADE,
  exception_id uuid REFERENCES public.fulfillment_exceptions(id) ON DELETE SET NULL,
  order_id uuid REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text,
  status text NOT NULL DEFAULT 'pending_customer'
    CHECK (status IN ('pending_customer', 'customer_accepted', 'customer_cancelled', 'withdrawn')),
  refund_state text NOT NULL DEFAULT 'not_required'
    CHECK (refund_state IN ('not_required', 'refund_pending', 'refund_completed')),
  reported_by uuid,
  device_id uuid,
  client_op_id text,
  customer_responded_at timestamptz,
  customer_response_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.fulfillment_shortages TO service_role;
ALTER TABLE public.fulfillment_shortages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fulfillment shortages are backend only"
  ON public.fulfillment_shortages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fulfillment_shortages_client_op
  ON public.fulfillment_shortages(fulfillment_id, client_op_id) WHERE client_op_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fulfillment_shortages_fulfillment ON public.fulfillment_shortages(fulfillment_id, status);

-- 扫码支持指定行 + 按数量累加（新增重载，保留旧签名给现有 APP）
CREATE OR REPLACE FUNCTION public.fulfillment_pick_scan(
  p_fulfillment_id uuid,
  p_location_id uuid,
  p_code text,
  p_device_id uuid,
  p_operator_id uuid,
  p_client_op_id text,
  p_fulfillment_item_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fulfillment public.fulfillments;
  v_item public.fulfillment_items;
  v_total integer;
  v_picked integer;
BEGIN
  IF p_client_op_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.fulfillment_scans
     WHERE device_id = p_device_id AND client_op_id = p_client_op_id
  ) THEN
    SELECT count(*), count(*) FILTER (WHERE picked_qty >= expected_qty)
      INTO v_total, v_picked
      FROM public.fulfillment_items WHERE fulfillment_id = p_fulfillment_id;
    RETURN jsonb_build_object('accepted', true, 'replayed', true, 'picked', v_picked, 'total', v_total);
  END IF;

  SELECT * INTO v_fulfillment FROM public.fulfillments
   WHERE id = p_fulfillment_id AND location_id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment not found at this location'; END IF;
  IF v_fulfillment.status NOT IN ('allocated','picking') THEN RAISE EXCEPTION 'fulfillment is not pickable'; END IF;

  SELECT fi.* INTO v_item
    FROM public.fulfillment_items fi
    JOIN public.inv_skus sku ON sku.id = fi.sku_id
   WHERE fi.fulfillment_id = p_fulfillment_id
     AND (p_fulfillment_item_id IS NULL OR fi.id = p_fulfillment_item_id)
     AND (fi.epc = p_code OR sku.epc = p_code OR sku.barcode = p_code OR sku.sku_code = p_code)
     AND fi.picked_qty < fi.expected_qty
   ORDER BY fi.picked_qty ASC
   LIMIT 1 FOR UPDATE OF fi;

  IF NOT FOUND THEN
    INSERT INTO public.fulfillment_scans(
      fulfillment_id, phase, code, code_type, result, rejection_reason, device_id, operator_id, client_op_id
    ) VALUES (
      p_fulfillment_id, 'pick', p_code, 'barcode', 'rejected',
      CASE WHEN p_fulfillment_item_id IS NULL THEN 'wrong_item' ELSE 'line_mismatch' END,
      p_device_id, p_operator_id, p_client_op_id
    );
    SELECT count(*), count(*) FILTER (WHERE picked_qty >= expected_qty)
      INTO v_total, v_picked
      FROM public.fulfillment_items WHERE fulfillment_id = p_fulfillment_id;
    RETURN jsonb_build_object(
      'accepted', false,
      'reason', CASE WHEN p_fulfillment_item_id IS NULL THEN 'wrong_item' ELSE 'line_mismatch' END,
      'picked', v_picked, 'total', v_total);
  END IF;

  UPDATE public.fulfillment_items
     SET picked_qty = least(picked_qty + 1, expected_qty),
         picked_at = coalesce(picked_at, now())
   WHERE id = v_item.id;

  INSERT INTO public.fulfillment_scans(
    fulfillment_id, fulfillment_item_id, phase, code, code_type, result, device_id, operator_id, client_op_id
  ) VALUES (
    p_fulfillment_id, v_item.id, 'pick', p_code, 'barcode', 'accepted', p_device_id, p_operator_id, p_client_op_id
  );

  UPDATE public.fulfillments
     SET status = 'picking',
         picking_started_at = coalesce(picking_started_at, now()),
         claimed_device_id = coalesce(claimed_device_id, p_device_id),
         updated_at = now()
   WHERE id = p_fulfillment_id;

  SELECT count(*), count(*) FILTER (WHERE picked_qty >= expected_qty)
    INTO v_total, v_picked
    FROM public.fulfillment_items WHERE fulfillment_id = p_fulfillment_id;
  RETURN jsonb_build_object('accepted', true, 'replayed', false,
    'fulfillment_item_id', v_item.id, 'picked', v_picked, 'total', v_total);
END; $$;

REVOKE ALL ON FUNCTION public.fulfillment_pick_scan(uuid,uuid,text,uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fulfillment_pick_scan(uuid,uuid,text,uuid,uuid,text,uuid) TO service_role;

-- 完成拣货：未确认缺货一律拒绝；客户已确认取消的行不再要求拣满
CREATE OR REPLACE FUNCTION public.fulfillment_complete_pick(
  p_fulfillment_id uuid, p_location_id uuid, p_device_id uuid
) RETURNS public.fulfillments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row public.fulfillments; v_missing integer; v_pending integer;
BEGIN
  SELECT count(*) INTO v_pending FROM public.fulfillment_shortages
   WHERE fulfillment_id = p_fulfillment_id AND status = 'pending_customer';
  IF v_pending > 0 THEN RAISE EXCEPTION 'shortage_pending_customer_confirmation'; END IF;

  SELECT count(*) INTO v_missing
    FROM public.fulfillment_items fi
   WHERE fi.fulfillment_id = p_fulfillment_id
     AND fi.picked_qty <> fi.expected_qty
     AND NOT EXISTS (
       SELECT 1 FROM public.fulfillment_shortages s
        WHERE s.fulfillment_item_id = fi.id AND s.status = 'customer_accepted'
     );
  IF v_missing > 0 THEN RAISE EXCEPTION 'fulfillment still has unpicked items'; END IF;

  UPDATE public.fulfillments SET status = 'picked', picked_at = now(), updated_at = now()
    WHERE id = p_fulfillment_id AND location_id = p_location_id AND status = 'picking'
      AND (claimed_device_id IS NULL OR claimed_device_id = p_device_id)
    RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment cannot complete picking'; END IF;
  RETURN v_row;
END; $$;

-- ============ D. 打印任务队列 ============
CREATE TABLE IF NOT EXISTS public.print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL REFERENCES public.fulfillments(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.inv_locations(id) ON DELETE SET NULL,
  ticket_type text NOT NULL CHECK (ticket_type IN ('pick_ticket', 'waybill')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'acked', 'failed', 'unknown')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_device_id uuid,
  lease_expires_at timestamptz,
  leased_at timestamptz,
  acked_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fulfillment_id, ticket_type)
);
GRANT ALL ON public.print_jobs TO service_role;
ALTER TABLE public.print_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "print jobs are backend only"
  ON public.print_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_print_jobs_location_status ON public.print_jobs(location_id, status, created_at);

-- 履约单建立即入队一张拣货小票（只由服务端 commerce_mark_order_paid 等流程触发）
CREATE OR REPLACE FUNCTION public.tg_fulfillment_enqueue_pick_ticket()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.print_jobs(fulfillment_id, order_id, location_id, ticket_type, status)
  VALUES (NEW.id, NEW.order_id, NEW.location_id, 'pick_ticket', 'queued')
  ON CONFLICT (fulfillment_id, ticket_type) DO NOTHING;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_fulfillment_enqueue_pick_ticket ON public.fulfillments;
CREATE TRIGGER trg_fulfillment_enqueue_pick_ticket
AFTER INSERT ON public.fulfillments
FOR EACH ROW EXECUTE FUNCTION public.tg_fulfillment_enqueue_pick_ticket();

-- 领取打印任务：同一门店设备互斥租约，避免多台重复打印
CREATE OR REPLACE FUNCTION public.print_jobs_lease(
  p_location_id uuid, p_device_id uuid, p_limit integer DEFAULT 5, p_lease_seconds integer DEFAULT 120
) RETURNS SETOF public.print_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.print_jobs pj
     SET status = 'leased',
         lease_device_id = p_device_id,
         leased_at = now(),
         lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 15)),
         attempts = pj.attempts + 1,
         updated_at = now()
   WHERE pj.id IN (
     SELECT id FROM public.print_jobs
      WHERE location_id = p_location_id
        AND (status = 'queued'
             OR (status = 'leased' AND lease_expires_at < now())
             OR (status = 'unknown' AND lease_expires_at < now()))
      ORDER BY created_at
      LIMIT greatest(1, least(p_limit, 20))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING pj.*;
END; $$;

REVOKE ALL ON FUNCTION public.print_jobs_lease(uuid,uuid,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.print_jobs_lease(uuid,uuid,integer,integer) TO service_role;

DROP TRIGGER IF EXISTS trg_print_jobs_updated_at ON public.print_jobs;
CREATE TRIGGER trg_print_jobs_updated_at BEFORE UPDATE ON public.print_jobs
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DROP TRIGGER IF EXISTS trg_support_conversations_updated_at ON public.support_conversations;
CREATE TRIGGER trg_support_conversations_updated_at BEFORE UPDATE ON public.support_conversations
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

DROP TRIGGER IF EXISTS trg_fulfillment_shortages_updated_at ON public.fulfillment_shortages;
CREATE TRIGGER trg_fulfillment_shortages_updated_at BEFORE UPDATE ON public.fulfillment_shortages
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();