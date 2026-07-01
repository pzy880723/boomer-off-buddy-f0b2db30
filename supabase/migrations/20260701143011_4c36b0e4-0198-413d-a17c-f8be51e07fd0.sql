
REVOKE EXECUTE ON FUNCTION public.inv_apply_movement(uuid, uuid, integer, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inv_apply_inbound_stock(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inv_apply_stock_delta(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gen_stock_transfer_code() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gen_ean13() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_japan_parcels_defaults() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_japan_parcel_items_defaults() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_inv_skus_fill_barcode() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_sku_youzan_links_role() FROM PUBLIC, anon, authenticated;
