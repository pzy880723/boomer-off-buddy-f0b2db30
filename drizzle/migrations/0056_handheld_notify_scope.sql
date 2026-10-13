-- 0056：手持通知增量变更可见范围收紧（同签名替换，非破坏性）。
-- 规则：location_id 为空或在 p_location_ids 内；且 (定向本人) 或 (未定向用户且 设备为空或为本设备)。
-- 同店但定向给其他员工/其他设备的通知不再下发；p_location_ids 由服务端按显式门店收窄为单店。
-- 回滚：重放 0052 中 handheld_notifications_changes 定义。
CREATE OR REPLACE FUNCTION public.handheld_notifications_changes(
  p_user_id uuid, p_device_id uuid, p_location_ids uuid[],
  p_after_xid text, p_after_seq bigint, p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, kind text, title text, payload jsonb, ts timestamptz, device_id uuid,
  location_id uuid, user_id uuid, action_status text, ref_type text, ref_id uuid,
  change_xid text, change_seq bigint, safe_xmin text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH w AS (SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin)
  SELECT n.id, n.kind, n.title, n.payload, n.ts, n.device_id, n.location_id, n.user_id,
         n.action_status, n.ref_type, n.ref_id, n.change_xid::text, n.change_seq, w.xmin::text
    FROM public.inv_handheld_notifications n, w
   WHERE n.change_xid < w.xmin
     AND (n.change_xid, n.change_seq) > (coalesce(p_after_xid, '0')::xid8, coalesce(p_after_seq, 0))
     AND (n.location_id IS NULL OR n.location_id = ANY (coalesce(p_location_ids, '{}')))
     AND (n.user_id = p_user_id
          OR (n.user_id IS NULL AND (n.device_id IS NULL OR n.device_id = p_device_id)))
   ORDER BY n.change_xid, n.change_seq
   LIMIT greatest(1, least(p_limit, 200))
$$;
REVOKE ALL ON FUNCTION public.handheld_notifications_changes(uuid,uuid,uuid[],text,bigint,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_notifications_changes(uuid,uuid,uuid[],text,bigint,integer) TO service_role;