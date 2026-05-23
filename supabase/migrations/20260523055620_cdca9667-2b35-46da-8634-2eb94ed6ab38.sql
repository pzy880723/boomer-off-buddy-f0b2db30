REVOKE EXECUTE ON FUNCTION public.inv_apply_inbound_stock(uuid, integer) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.inv_apply_stock_delta(uuid, integer) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.gen_stock_transfer_code() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.inv_apply_inbound_stock(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_apply_stock_delta(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.gen_stock_transfer_code() TO service_role;