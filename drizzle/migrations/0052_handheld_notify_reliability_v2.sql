-- 手持提醒可靠性：变更游标（xid8 快照水位）+ 付款提醒持久补偿 + 已读跨设备同步。（0051 误为空迁移，本文件为实际内容）
-- 回滚（按序）：
--   DROP TRIGGER trg_notif_read_bump ON public.handheld_notification_reads; DROP FUNCTION public.tg_notif_read_bump();
--   DROP TRIGGER trg_notif_change_stamp ON public.inv_handheld_notifications; DROP FUNCTION public.tg_notif_change_stamp();
--   DROP FUNCTION public.handheld_notifications_changes(uuid,uuid,uuid[],text,bigint,integer); DROP FUNCTION public.handheld_notifications_watermark();
--   DROP FUNCTION public.handheld_notify_reconcile(integer,integer);
--   DROP TRIGGER trg_order_paid_notify ON public.commerce_orders; 再用 0049 原 WHEN 条件重建该触发器；
--   DROP INDEX public.idx_handheld_notif_change; ALTER TABLE public.inv_handheld_notifications DROP COLUMN change_seq, DROP COLUMN change_xid;
--   DROP SEQUENCE public.handheld_notif_change_seq;
CREATE SEQUENCE IF NOT EXISTS public.handheld_notif_change_seq;
GRANT USAGE ON SEQUENCE public.handheld_notif_change_seq TO service_role;
ALTER TABLE public.inv_handheld_notifications ADD COLUMN IF NOT EXISTS change_xid xid8;
ALTER TABLE public.inv_handheld_notifications ADD COLUMN IF NOT EXISTS change_seq bigint;
UPDATE public.inv_handheld_notifications n SET change_xid = pg_current_xact_id(), change_seq = s.seq
  FROM (SELECT id, nextval('public.handheld_notif_change_seq') AS seq FROM
        (SELECT id FROM public.inv_handheld_notifications ORDER BY ts, id) o) s
 WHERE s.id = n.id AND n.change_seq IS NULL;
CREATE INDEX IF NOT EXISTS idx_handheld_notif_change ON public.inv_handheld_notifications (change_xid, change_seq);

CREATE OR REPLACE FUNCTION public.tg_notif_change_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.change_xid := pg_current_xact_id();
  NEW.change_seq := nextval('public.handheld_notif_change_seq');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_notif_change_stamp ON public.inv_handheld_notifications;
CREATE TRIGGER trg_notif_change_stamp BEFORE INSERT OR UPDATE ON public.inv_handheld_notifications
  FOR EACH ROW EXECUTE FUNCTION public.tg_notif_change_stamp();

CREATE OR REPLACE FUNCTION public.tg_notif_read_bump() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.inv_handheld_notifications SET change_seq = change_seq WHERE id = NEW.notification_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.tg_notif_read_bump(), public.tg_notif_change_stamp() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_notif_read_bump ON public.handheld_notification_reads;
CREATE TRIGGER trg_notif_read_bump AFTER INSERT ON public.handheld_notification_reads
  FOR EACH ROW EXECUTE FUNCTION public.tg_notif_read_bump();

DROP TRIGGER IF EXISTS trg_order_paid_notify ON public.commerce_orders;
CREATE TRIGGER trg_order_paid_notify AFTER UPDATE OF payment_status ON public.commerce_orders
  FOR EACH ROW WHEN (NEW.payment_status = 'paid')
  EXECUTE FUNCTION public.tg_order_paid_notify();

CREATE OR REPLACE FUNCTION public.handheld_notify_reconcile(p_days integer DEFAULT 7, p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; total integer := 0; n integer;
BEGIN
  FOR r IN
    SELECT DISTINCT o.id, o.paid_at FROM public.commerce_orders o
      JOIN public.fulfillments f ON f.order_id = o.id
     WHERE o.payment_status = 'paid' AND o.source_channel = 'storefront'
       AND o.order_status NOT IN ('cancelled','closed')
       AND o.paid_at >= now() - make_interval(days => greatest(1, least(p_days, 30)))
       AND f.location_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.inv_handheld_notifications n
                        WHERE n.kind = 'order_paid' AND n.ref_id = f.id)
     ORDER BY o.paid_at LIMIT greatest(1, least(p_limit, 500))
  LOOP
    BEGIN
      n := public.handheld_notify_order_paid(r.id);
      total := total + n;
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'order_paid reconcile failed: %', SQLSTATE;
    END;
  END LOOP;
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION public.handheld_notify_reconcile(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_notify_reconcile(integer,integer) TO service_role;

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
     AND (n.user_id = p_user_id OR n.device_id = p_device_id
          OR (n.user_id IS NULL AND n.device_id IS NULL AND n.location_id IS NULL)
          OR n.location_id = ANY (coalesce(p_location_ids, '{}')))
   ORDER BY n.change_xid, n.change_seq
   LIMIT greatest(1, least(p_limit, 200))
$$;
CREATE OR REPLACE FUNCTION public.handheld_notifications_watermark() RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$ SELECT pg_snapshot_xmin(pg_current_snapshot())::text $$;
REVOKE ALL ON FUNCTION public.handheld_notifications_changes(uuid,uuid,uuid[],text,bigint,integer),
  public.handheld_notifications_watermark() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_notifications_changes(uuid,uuid,uuid[],text,bigint,integer),
  public.handheld_notifications_watermark() TO service_role;
