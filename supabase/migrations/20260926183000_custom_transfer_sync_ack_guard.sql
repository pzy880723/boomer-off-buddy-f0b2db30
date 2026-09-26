-- Source stock acknowledgements are written by the trusted sync worker only.
CREATE INDEX IF NOT EXISTS stock_transfer_lines_source_sync_idx
  ON public.stock_transfer_lines(source_sync_id) WHERE source_sync_id IS NOT NULL;

CREATE FUNCTION public.custom_transfer_queue_is_unlinked(p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.stock_transfer_lines WHERE source_sync_id = p_id
  );
$$;
REVOKE ALL ON FUNCTION public.custom_transfer_queue_is_unlinked(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.custom_transfer_queue_is_unlinked(uuid) TO authenticated, service_role;

CREATE POLICY custom_transfer_queue_update_guard ON public.youzan_stock_sync_queue
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.custom_transfer_queue_is_unlinked(id))
  WITH CHECK (public.custom_transfer_queue_is_unlinked(id));
CREATE POLICY custom_transfer_queue_delete_guard ON public.youzan_stock_sync_queue
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (public.custom_transfer_queue_is_unlinked(id));
CREATE POLICY custom_transfer_queue_insert_guard ON public.youzan_stock_sync_queue
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.custom_transfer_queue_is_unlinked(id));
