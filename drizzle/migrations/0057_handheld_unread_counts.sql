-- 0057：手持未读角标全量计数（新增函数，非破坏性）。回滚：DROP FUNCTION public.handheld_unread_counts(uuid,uuid,uuid[],boolean);
-- customers：p_location_ids 内全部客服会话（p_include_unlocated=true 时含无门店总部会话）中，晚于本人 last_read_at 的顾客消息数。
-- internal/orders/system：与 handheld_notifications_changes 同一可见规则、本人尚未已读的通知；客服类通知(kind like 'support%')不计入，避免与 customers 重复。
CREATE OR REPLACE FUNCTION public.handheld_unread_counts(
  p_user_id uuid, p_device_id uuid, p_location_ids uuid[], p_include_unlocated boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH n AS (
    SELECT CASE
             WHEN n.kind = 'order_paid' THEN 'orders'
             WHEN n.kind IN ('stocktake_assigned','transfer_incoming','unclaimed_epc_pending') THEN 'internal'
             ELSE 'system' END AS cat
      FROM public.inv_handheld_notifications n
     WHERE n.kind NOT LIKE 'support%'
       AND (n.location_id IS NULL OR n.location_id = ANY (coalesce(p_location_ids, '{}')))
       AND (n.user_id = p_user_id OR (n.user_id IS NULL AND (n.device_id IS NULL OR n.device_id = p_device_id)))
       AND NOT EXISTS (SELECT 1 FROM public.handheld_notification_reads r WHERE r.notification_id = n.id AND r.user_id = p_user_id)
  ), c AS (
    SELECT count(*)::int AS customers
      FROM public.support_conversations sc
      JOIN public.support_messages m ON m.conversation_id = sc.id AND m.sender_type = 'customer'
      LEFT JOIN public.support_participants p ON p.conversation_id = sc.id AND p.user_id = p_user_id
     WHERE (sc.location_id = ANY (coalesce(p_location_ids, '{}')) OR (p_include_unlocated AND sc.location_id IS NULL))
       AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
  ), k AS (
    SELECT count(*) FILTER (WHERE cat = 'internal')::int AS internal,
           count(*) FILTER (WHERE cat = 'orders')::int AS orders,
           count(*) FILTER (WHERE cat = 'system')::int AS system
      FROM n
  )
  SELECT jsonb_build_object('customers', c.customers, 'internal', k.internal, 'orders', k.orders, 'system', k.system,
                            'total', c.customers + k.internal + k.orders + k.system)
    FROM c, k
$$;
REVOKE ALL ON FUNCTION public.handheld_unread_counts(uuid,uuid,uuid[],boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_unread_counts(uuid,uuid,uuid[],boolean) TO service_role;