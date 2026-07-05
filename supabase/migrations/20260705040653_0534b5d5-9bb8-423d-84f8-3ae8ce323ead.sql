ALTER TABLE public.youzan_stock_sync_queue DROP CONSTRAINT IF EXISTS youzan_stock_sync_queue_action_check;
ALTER TABLE public.youzan_stock_sync_queue ADD CONSTRAINT youzan_stock_sync_queue_action_check CHECK (action = ANY (ARRAY[
  'update_stock','create_and_bind','create_branch_listing','push_stock'
]));