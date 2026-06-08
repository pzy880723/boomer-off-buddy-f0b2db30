-- Lock down SECURITY DEFINER functions: revoke broad execute grants
REVOKE EXECUTE ON FUNCTION public.tg_set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_japan_parcels_defaults() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tg_japan_parcel_items_defaults() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inv_apply_inbound_stock(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.inv_apply_stock_delta(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gen_stock_transfer_code() FROM PUBLIC, anon, authenticated;

-- Re-grant only what the app actually calls via the authenticated client
GRANT EXECUTE ON FUNCTION public.inv_apply_stock_delta(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gen_stock_transfer_code() TO authenticated;
-- inv_apply_inbound_stock is only invoked through the service-role admin client; service_role retains access by default.
-- Trigger functions (tg_*) run in trigger context and do not need direct EXECUTE grants.