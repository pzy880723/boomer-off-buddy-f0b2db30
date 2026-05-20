CREATE TABLE public.pending_sort_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id uuid NOT NULL,
  parcel_item_id uuid NOT NULL,
  title text,
  image_url text,
  source_label text,
  status text NOT NULL DEFAULT 'pending',
  notes text,
  received_at timestamptz NOT NULL DEFAULT now(),
  sorted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pending_sort_items_status_idx
  ON public.pending_sort_items(status, received_at DESC);

CREATE UNIQUE INDEX pending_sort_items_uniq_pi
  ON public.pending_sort_items(parcel_item_id);

ALTER TABLE public.pending_sort_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY open_select_pending_sort_items ON public.pending_sort_items
  FOR SELECT USING (true);
CREATE POLICY open_insert_pending_sort_items ON public.pending_sort_items
  FOR INSERT WITH CHECK (true);
CREATE POLICY open_update_pending_sort_items ON public.pending_sort_items
  FOR UPDATE USING (true);
CREATE POLICY open_delete_pending_sort_items ON public.pending_sort_items
  FOR DELETE USING (true);

CREATE TRIGGER tg_pending_sort_items_updated_at
  BEFORE UPDATE ON public.pending_sort_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 回填：所有已签收（delivered/completed）包裹下的子商品
INSERT INTO public.pending_sort_items
  (parcel_id, parcel_item_id, title, image_url, source_label, received_at)
SELECT
  p.id,
  i.id,
  COALESCE(i.item_title_cn, i.item_title, '(未命名)'),
  i.item_image_url,
  CONCAT_WS(' · ',
    NULLIF(COALESCE(p.tracking_no, p.source_order_no), ''),
    NULLIF(p.seller, '')
  ),
  COALESCE(p.received_at, p.updated_at, now())
FROM public.japan_parcels p
JOIN public.japan_parcel_items i ON i.parent_id = p.id
WHERE p.deleted_at IS NULL
  AND p.status IN ('delivered', 'completed')
ON CONFLICT (parcel_item_id) DO NOTHING;