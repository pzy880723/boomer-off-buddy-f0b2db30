REVOKE EXECUTE ON FUNCTION public.tg_set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_japan_parcels_defaults() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_japan_parcel_items_defaults() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inv_apply_inbound_stock(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inv_apply_stock_delta(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gen_stock_transfer_code() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inv_apply_movement(uuid, uuid, integer, text, uuid, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.tg_set_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.tg_japan_parcels_defaults() TO service_role;
GRANT EXECUTE ON FUNCTION public.tg_japan_parcel_items_defaults() TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_apply_inbound_stock(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_apply_stock_delta(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.gen_stock_transfer_code() TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_apply_movement(uuid, uuid, integer, text, uuid, text, text) TO service_role;