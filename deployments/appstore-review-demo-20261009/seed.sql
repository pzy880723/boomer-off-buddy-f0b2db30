-- BOOMER OFF App Store review DEMO seed — manual use only, on an EMPTY independent instance.
-- Never run against the production Lovable Cloud database or the existing Tencent data instance.
-- Not part of drizzle/supabase migrations; nothing applies it automatically.
--
-- Prerequisites (Codex): schema already restored (structure only), demo staff accounts created
-- through THIS instance's Auth admin API with user_metadata.name = '演示总部账号' / '演示店员'.
-- Usage:
--   psql "$REVIEW_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v hq_user_id=<uuid> -v staff_user_id=<uuid> -f seed.sql
-- Re-runnable: fixed ids + ON CONFLICT DO NOTHING.
\set ON_ERROR_STOP on
BEGIN;

SELECT set_config('review.hq_user_id', :'hq_user_id', true),
       set_config('review.staff_user_id', :'staff_user_id', true);

DO $guard$
DECLARE
  hq uuid := current_setting('review.hq_user_id')::uuid;
  st uuid := current_setting('review.staff_user_id')::uuid;
BEGIN
  IF hq = st THEN RAISE EXCEPTION 'review seed: hq and staff must be different demo accounts'; END IF;
  IF (SELECT count(*) FROM auth.users WHERE id IN (hq, st)) <> 2 THEN
    RAISE EXCEPTION 'review seed: demo users must already exist in THIS instance Auth';
  END IF;
  IF (SELECT count(*) FROM auth.users) > 10 THEN
    RAISE EXCEPTION 'review seed: target has too many auth users; looks like a production instance';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inv_locations WHERE name NOT LIKE '演示%')
     OR EXISTS (SELECT 1 FROM public.inv_skus WHERE name NOT LIKE '演示%')
     OR EXISTS (SELECT 1 FROM public.commerce_orders WHERE coalesce(metadata->>'demo', '') <> 'true')
     OR EXISTS (SELECT 1 FROM public.youzan_shops) THEN
    RAISE EXCEPTION 'review seed: target database contains non-demo data; refusing';
  END IF;
END
$guard$;

-- Locations: demo HQ warehouse + demo shop (no Youzan shop link)
INSERT INTO public.inv_locations (id, kind, name, is_active, notes) VALUES
  ('de000000-0000-4000-8000-000000000001', 'warehouse', '演示总部仓（App 审核）', true, '演示数据，非真实门店'),
  ('de000000-0000-4000-8000-000000000002', 'shop', '演示门店（App 审核）', true, '演示数据，非真实门店')
ON CONFLICT DO NOTHING;

-- Roles + store scope for the two demo staff accounts
INSERT INTO public.user_roles (user_id, role) VALUES
  (current_setting('review.hq_user_id')::uuid, 'hq_operator'),
  (current_setting('review.staff_user_id')::uuid, 'store_staff')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_location_perms (user_id, location_id) VALUES
  (current_setting('review.staff_user_id')::uuid, 'de000000-0000-4000-8000-000000000002'),
  (current_setting('review.hq_user_id')::uuid, 'de000000-0000-4000-8000-000000000001'),
  (current_setting('review.hq_user_id')::uuid, 'de000000-0000-4000-8000-000000000002')
ON CONFLICT DO NOTHING;

-- Categories (demo codes only)
INSERT INTO public.inv_categories (id, code, name, sort_order, is_active, is_system) VALUES
  ('de000000-0000-4000-8000-000000000011', 'demo_tableware', '演示·餐具杯具', 1, true, false),
  ('de000000-0000-4000-8000-000000000012', 'demo_paper', '演示·纸品文具', 2, true, false)
ON CONFLICT DO NOTHING;

-- Products: custom (unique item) on sale, custom already sold, standard tracked item. No images.
INSERT INTO public.inv_skus (id, category, price_tier, name, kind, epc, stock_qty, notes, status,
  is_custom_price, sku_code, grade, is_display, sku_scope, sales_state, inventory_policy,
  sale_ownership, attributes, category_source) VALUES
  ('de000000-0000-4000-8000-000000000101', 'demo_tableware', 128, '演示孤品·昭和玻璃杯（审核演示）', 'single',
   'DEMO00000000000000000101', 1, '演示数据，非真实商品', 'active', true, 'DEMO-C-0101', 'A', true,
   'custom', 'active', 'tracked', 'owned', '{"demo": true}', 'manual'),
  ('de000000-0000-4000-8000-000000000102', 'demo_tableware', 98, '演示孤品·复古搪瓷盘（已售演示）', 'single',
   'DEMO00000000000000000102', 0, '演示数据，非真实商品', 'active', true, 'DEMO-C-0102', 'B', true,
   'custom', 'sold', 'tracked', 'owned', '{"demo": true}', 'manual'),
  ('de000000-0000-4000-8000-000000000103', 'demo_paper', 15, '演示标准品·店铺明信片', 'single',
   'DEMO00000000000000000103', 20, '演示数据，非真实商品', 'active', false, 'DEMO-S-0103', NULL, true,
   'standard', 'active', 'tracked', 'owned', '{"demo": true}', 'manual')
ON CONFLICT DO NOTHING;

INSERT INTO public.inv_stocks (sku_id, location_id, qty) VALUES
  ('de000000-0000-4000-8000-000000000101', 'de000000-0000-4000-8000-000000000002', 1),
  ('de000000-0000-4000-8000-000000000102', 'de000000-0000-4000-8000-000000000002', 0),
  ('de000000-0000-4000-8000-000000000103', 'de000000-0000-4000-8000-000000000002', 20)
ON CONFLICT DO NOTHING;

-- One completed in-store demo order (no real payment, no customer account)
INSERT INTO public.commerce_orders (id, order_no, payment_status, order_status, currency, subtotal,
  shipping_fee, discount_total, total_amount, recipient_name, customer_note, idempotency_key,
  reservation_expires_at, paid_at, completed_at, source_channel, fulfillment_method,
  sale_location_id, operator_id, metadata) VALUES
  ('de000000-0000-4000-8000-000000000201', 'DEMO-20261009-0001', 'paid', 'completed', 'CNY', 98,
   0, 0, 98, '演示顾客', '演示订单：未发生真实支付', 'demo-review-order-0001',
   now(), now(), now(), 'pos', 'carryout',
   'de000000-0000-4000-8000-000000000002', current_setting('review.staff_user_id')::uuid,
   '{"demo": true, "note": "App 审核演示订单，未连接真实支付/有赞"}')
ON CONFLICT DO NOTHING;

INSERT INTO public.commerce_order_items (id, order_id, sku_id, location_id, title_snapshot,
  condition_snapshot, unit_price, quantity, line_total, ownership_snapshot, category_code) VALUES
  ('de000000-0000-4000-8000-000000000301', 'de000000-0000-4000-8000-000000000201',
   'de000000-0000-4000-8000-000000000102', 'de000000-0000-4000-8000-000000000002',
   '演示孤品·复古搪瓷盘（已售演示）', 'B', 98, 1, 98, 'owned', 'demo_tableware')
ON CONFLICT DO NOTHING;

-- Internal staff ↔ HQ message thread (native channel, no customer, no WeChat)
INSERT INTO public.support_agents (id, user_id, scope, location_id, display_name, is_active) VALUES
  ('de000000-0000-4000-8000-000000000401', current_setting('review.hq_user_id')::uuid, 'hq', NULL, '演示总部客服', true)
ON CONFLICT DO NOTHING;

INSERT INTO public.support_conversations (id, title, location_id, topic, status, channel,
  context_key, context, last_message_preview) VALUES
  ('de000000-0000-4000-8000-000000000501', '演示：门店内部咨询', 'de000000-0000-4000-8000-000000000002',
   'demo', 'open', 'native', 'demo-review-0501', '{"demo": true}', '【演示】请确认玻璃杯陈列位置')
ON CONFLICT DO NOTHING;

INSERT INTO public.support_participants (id, conversation_id, user_id, participant_role, display_name) VALUES
  ('de000000-0000-4000-8000-000000000601', 'de000000-0000-4000-8000-000000000501',
   current_setting('review.staff_user_id')::uuid, 'store_staff', '演示店员'),
  ('de000000-0000-4000-8000-000000000602', 'de000000-0000-4000-8000-000000000501',
   current_setting('review.hq_user_id')::uuid, 'hq_agent', '演示总部客服')
ON CONFLICT DO NOTHING;

INSERT INTO public.support_messages (id, conversation_id, sender_type, sender_user_id, sender_name,
  body, internal, client_op_id, delivery_status) VALUES
  ('de000000-0000-4000-8000-000000000701', 'de000000-0000-4000-8000-000000000501', 'staff',
   current_setting('review.staff_user_id')::uuid, '演示店员', '【演示】请确认玻璃杯陈列位置', false,
   'demo-review-msg-0701', 'sent'),
  ('de000000-0000-4000-8000-000000000702', 'de000000-0000-4000-8000-000000000501', 'staff',
   current_setting('review.hq_user_id')::uuid, '演示总部客服', '【演示】放在入口第二层即可', false,
   'demo-review-msg-0702', 'sent')
ON CONFLICT DO NOTHING;

SELECT 'locations' AS t, count(*) FROM public.inv_locations WHERE id::text LIKE 'de000000-%'
UNION ALL SELECT 'skus', count(*) FROM public.inv_skus WHERE id::text LIKE 'de000000-%'
UNION ALL SELECT 'orders', count(*) FROM public.commerce_orders WHERE id::text LIKE 'de000000-%'
UNION ALL SELECT 'messages', count(*) FROM public.support_messages WHERE id::text LIKE 'de000000-%';

COMMIT;
