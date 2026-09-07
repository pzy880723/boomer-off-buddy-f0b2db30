REVOKE ALL ON public.go_shop_location_links FROM anon;
REVOKE ALL ON public.user_scope_audit_logs FROM anon;
REVOKE ALL ON public.youzan_order_sync_cursors FROM anon;

REVOKE ALL ON public.go_shop_location_links FROM authenticated;
REVOKE ALL ON public.user_scope_audit_logs FROM authenticated;
REVOKE ALL ON public.youzan_order_sync_cursors FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON public.go_shop_location_links TO authenticated;
GRANT SELECT ON public.user_scope_audit_logs TO authenticated;
GRANT SELECT ON public.youzan_order_sync_cursors TO authenticated;

GRANT ALL ON public.go_shop_location_links TO service_role;
GRANT ALL ON public.user_scope_audit_logs TO service_role;
GRANT ALL ON public.youzan_order_sync_cursors TO service_role;