-- One operation is a logical stock/display request, not a worker attempt.
-- Retrying unchanged failed work keeps its remote idempotency key. Explicit
-- enqueues supply a new UUID even if the requested quantity has not changed.
ALTER TABLE public.youzan_stock_sync_queue
  ADD COLUMN IF NOT EXISTS operation_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION public.youzan_stock_queue_operation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.operation_id IS NULL THEN
    NEW.operation_id := gen_random_uuid();
  ELSIF NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id AND (
    NEW.sku_id IS DISTINCT FROM OLD.sku_id
    OR NEW.shop_id IS DISTINCT FROM OLD.shop_id
    OR NEW.location_id IS DISTINCT FROM OLD.location_id
    OR NEW.target_stock IS DISTINCT FROM OLD.target_stock
    OR NEW.action IS DISTINCT FROM OLD.action
    OR NEW.target_is_display IS DISTINCT FROM OLD.target_is_display
    OR (OLD.status IN ('done', 'cancelled') AND NEW.status = 'pending')
  ) THEN
    NEW.operation_id := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_youzan_stock_queue_operation ON public.youzan_stock_sync_queue;
CREATE TRIGGER trg_youzan_stock_queue_operation
  BEFORE UPDATE ON public.youzan_stock_sync_queue
  FOR EACH ROW EXECUTE FUNCTION public.youzan_stock_queue_operation();

COMMENT ON COLUMN public.youzan_stock_sync_queue.operation_id IS
  'Logical request UUID; stable across claim/failure/retry, fresh for changed intent or explicit enqueue. Not a remote-call cancellation fence.';
