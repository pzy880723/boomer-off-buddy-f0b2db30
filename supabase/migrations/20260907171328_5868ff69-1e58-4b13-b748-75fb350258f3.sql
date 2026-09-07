CREATE TABLE public.youzan_order_sync_cursors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.youzan_shops(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  next_page integer NOT NULL DEFAULT 1,
  method_label text,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  total_upserted integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  last_progress_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT youzan_order_sync_cursors_status_chk
    CHECK (status IN ('pending','running','done','error'))
);

CREATE UNIQUE INDEX youzan_order_sync_cursors_shop_window_uniq
  ON public.youzan_order_sync_cursors (shop_id, window_start, window_end);

CREATE INDEX youzan_order_sync_cursors_claimable_idx
  ON public.youzan_order_sync_cursors (status, lease_expires_at);

GRANT SELECT ON public.youzan_order_sync_cursors TO authenticated;
GRANT ALL ON public.youzan_order_sync_cursors TO service_role;

ALTER TABLE public.youzan_order_sync_cursors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "HQ can read youzan order sync cursors"
  ON public.youzan_order_sync_cursors FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'hq_operator')
  );

CREATE TRIGGER youzan_order_sync_cursors_set_updated_at
  BEFORE UPDATE ON public.youzan_order_sync_cursors
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE OR REPLACE FUNCTION public.youzan_claim_order_sync_cursor(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS public.youzan_order_sync_cursors
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.youzan_order_sync_cursors;
BEGIN
  UPDATE public.youzan_order_sync_cursors c
     SET status = 'running',
         lease_owner = p_worker_id,
         lease_expires_at = now() + make_interval(secs => GREATEST(p_lease_seconds, 30)),
         attempts = c.attempts + 1,
         updated_at = now()
   WHERE c.id = (
     SELECT s.id
       FROM public.youzan_order_sync_cursors s
      WHERE (
              s.status IN ('pending','error')
              OR (s.status = 'running' AND (s.lease_expires_at IS NULL OR s.lease_expires_at < now()))
            )
        AND s.attempts < 20
      ORDER BY s.updated_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
   RETURNING c.* INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.youzan_claim_order_sync_cursor(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_claim_order_sync_cursor(text, integer) TO service_role;