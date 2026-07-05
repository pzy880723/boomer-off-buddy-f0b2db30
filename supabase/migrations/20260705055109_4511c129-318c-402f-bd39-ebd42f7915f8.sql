DELETE FROM public.sku_youzan_links WHERE status = 'error' AND (yz_item_id IS NULL OR yz_item_id = 0);

UPDATE public.youzan_stock_sync_queue
   SET status = 'pending', attempts = 0, last_error = NULL, next_run_at = now(), updated_at = now()
 WHERE status = 'failed';

INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('youzan_hq_default_category_id', 'null'::jsonb, now())
ON CONFLICT (key) DO NOTHING;