-- 0058：替换 handheld_unread_counts 分类为统一合约（非破坏性 CREATE OR REPLACE，签名不变）。
-- 回滚：重放 0057_handheld_unread_counts.sql 中的函数定义，并 DROP FUNCTION public.handheld_notification_category(text)。
-- kind 规范化：lower + '.'/'-' → '_'；类别 = 精确前缀或 前缀_*：
--   customers: customer/conversation/support/inquiry（此类通知不计数，customers 只来自客服未读消息）
--   orders:    order/refund/fulfillment/shipment/shortage/pickup
--   internal:  internal/announcement/transfer/stocktake
--   其余 system
CREATE OR REPLACE FUNCTION public.handheld_notification_category(p_kind text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  WITH k AS (SELECT translate(lower(coalesce(p_kind,'')), '.-', '__') AS v)
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['customer','conversation','support','inquiry']) p WHERE k.v = p OR k.v LIKE p || '\_%') THEN 'customers'
    WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['order','refund','fulfillment','shipment','shortage','pickup']) p WHERE k.v = p OR k.v LIKE p || '\_%') THEN 'orders'
    WHEN EXISTS (SELECT 1 FROM unnest(ARRAY['internal','announcement','transfer','stocktake']) p WHERE k.v = p OR k.v LIKE p || '\_%') THEN 'internal'
    ELSE 'system' END
  FROM k
$$;
REVOKE ALL ON FUNCTION public.handheld_notification_category(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_notification_category(text) TO service_role;

CREATE OR REPLACE FUNCTION public.handheld_unread_counts(
  p_user_id uuid, p_device_id uuid, p_location_ids uuid[], p_include_unlocated boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH n AS (
    SELECT public.handheld_notification_category(n.kind) AS cat
      FROM public.inv_handheld_notifications n
     WHERE (n.location_id IS NULL OR n.location_id = ANY (coalesce(p_location_ids, '{}')))
       AND (n.user_id = p_user_id OR (n.user_id IS NULL AND (n.device_id IS NULL OR n.device_id = p_device_id)))
       AND NOT EXISTS (SELECT 1 FROM public.handheld_notification_reads r WHERE r.notification_id = n.id AND r.user_id = p_user_id)
  ), c AS (
    SELECT count(*)::bigint AS customers
      FROM public.support_conversations sc
      JOIN public.support_messages m ON m.conversation_id = sc.id AND m.sender_type = 'customer'
      LEFT JOIN public.support_participants p ON p.conversation_id = sc.id AND p.user_id = p_user_id
     WHERE (sc.location_id = ANY (coalesce(p_location_ids, '{}')) OR (p_include_unlocated AND sc.location_id IS NULL))
       AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
  ), k AS (
    SELECT count(*) FILTER (WHERE cat = 'internal')::bigint AS internal,
           count(*) FILTER (WHERE cat = 'orders')::bigint AS orders,
           count(*) FILTER (WHERE cat = 'system')::bigint AS system
      FROM n
  )
  SELECT jsonb_build_object('customers', c.customers, 'internal', k.internal, 'orders', k.orders, 'system', k.system,
                            'total', c.customers + k.internal + k.orders + k.system)
    FROM c, k
$$;
REVOKE ALL ON FUNCTION public.handheld_unread_counts(uuid,uuid,uuid[],boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_unread_counts(uuid,uuid,uuid[],boolean) TO service_role;