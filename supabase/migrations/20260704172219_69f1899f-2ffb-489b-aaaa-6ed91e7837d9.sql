ALTER TABLE public.inv_stock_movements DROP CONSTRAINT IF EXISTS inv_stock_movements_ref_type_check;
ALTER TABLE public.inv_stock_movements ADD CONSTRAINT inv_stock_movements_ref_type_check CHECK (ref_type = ANY (ARRAY[
  'rfid_inbound','transfer_out','transfer_in','stocktake_adjust','youzan_sale','unclaim','manual_adjust',
  'shop_adjust','shop_new_sku','claim_epc','stocktake','yz_trade','yz_refund',
  'handheld_inbound','handheld_smart_create','transfer_receive','transfer_ship',
  'rfid_bind','rfid_relocate_out','rfid_relocate_in'
]));