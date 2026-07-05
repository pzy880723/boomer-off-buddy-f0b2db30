
-- 1) inv_skus.is_display
ALTER TABLE public.inv_skus ADD COLUMN IF NOT EXISTS is_display boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_inv_skus_is_display ON public.inv_skus(is_display);

-- 2) inv_stock_movements.ref_type: allow handheld_restock
ALTER TABLE public.inv_stock_movements DROP CONSTRAINT IF EXISTS inv_stock_movements_ref_type_check;
ALTER TABLE public.inv_stock_movements ADD CONSTRAINT inv_stock_movements_ref_type_check CHECK (ref_type = ANY (ARRAY[
  'rfid_inbound','transfer_out','transfer_in','stocktake_adjust','youzan_sale','unclaim','manual_adjust',
  'shop_adjust','shop_new_sku','claim_epc','stocktake','yz_trade','yz_refund',
  'handheld_inbound','handheld_smart_create','handheld_restock','transfer_receive','transfer_ship',
  'rfid_bind','rfid_relocate_out','rfid_relocate_in'
]));

-- 3) youzan_stock_sync_queue: new action + target_is_display column
ALTER TABLE public.youzan_stock_sync_queue ADD COLUMN IF NOT EXISTS target_is_display boolean;
ALTER TABLE public.youzan_stock_sync_queue DROP CONSTRAINT IF EXISTS youzan_stock_sync_queue_action_check;
ALTER TABLE public.youzan_stock_sync_queue ADD CONSTRAINT youzan_stock_sync_queue_action_check CHECK (action = ANY (ARRAY[
  'update_stock','create_and_bind','create_branch_listing','push_stock','push_is_display'
]));
