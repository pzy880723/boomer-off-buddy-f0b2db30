
-- 1. Partial unique index: avoid duplicate pending/failed pushes for the same (sku, shop)
CREATE UNIQUE INDEX IF NOT EXISTS uq_youzan_stock_sync_queue_pending
  ON public.youzan_stock_sync_queue (sku_id, shop_id)
  WHERE status IN ('pending', 'failed');

-- 2. AFTER INSERT trigger on inv_stock_movements: any movement at a shop location enqueues a push
CREATE OR REPLACE FUNCTION public.tg_shop_movement_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind text;
  v_shop uuid;
  v_target integer;
BEGIN
  SELECT kind, shop_id INTO v_kind, v_shop
    FROM public.inv_locations
    WHERE id = NEW.location_id;

  IF v_kind IS DISTINCT FROM 'shop' OR v_shop IS NULL THEN
    RETURN NEW;
  END IF;

  -- Current stock at that (sku, location) — balance_after is the fresh value
  v_target := GREATEST(0, COALESCE(NEW.balance_after, 0));

  INSERT INTO public.youzan_stock_sync_queue
    (sku_id, shop_id, location_id, target_stock, action, reason, status, next_run_at)
  VALUES
    (NEW.sku_id, v_shop, NEW.location_id, v_target,
     'push_stock',
     COALESCE(NEW.ref_type, 'movement'),
     'pending', now())
  ON CONFLICT (sku_id, shop_id) WHERE status IN ('pending', 'failed')
  DO UPDATE SET
    target_stock = EXCLUDED.target_stock,
    location_id  = EXCLUDED.location_id,
    reason       = EXCLUDED.reason,
    next_run_at  = now(),
    status       = 'pending',
    last_error   = NULL,
    updated_at   = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_movement_enqueue ON public.inv_stock_movements;
CREATE TRIGGER trg_shop_movement_enqueue
  AFTER INSERT ON public.inv_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.tg_shop_movement_enqueue();

-- 3. pg_cron: run worker every minute (fallback for handheld's fire-and-forget)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- unschedule if exists (idempotent re-runs)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'youzan-stock-worker-tick') THEN
    PERFORM cron.unschedule('youzan-stock-worker-tick');
  END IF;
END $$;

SELECT cron.schedule(
  'youzan-stock-worker-tick',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://project--2158bffa-7f82-4bc6-9df9-c59319d262f7.lovable.app/api/public/hooks/youzan-stock-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_RiQ9EkQg9tSTjEQFpa0znA_3mIefbAw'
    ),
    body := '{}'::jsonb
  );
  $cron$
);
