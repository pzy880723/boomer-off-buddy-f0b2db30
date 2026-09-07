REVOKE ALL ON public.store_monthly_target_plans FROM anon, PUBLIC;
REVOKE ALL ON public.store_daily_targets FROM anon, PUBLIC;
REVOKE ALL ON public.store_target_audit_logs FROM anon, PUBLIC;
REVOKE ALL ON public.store_offline_sales_entries FROM anon, PUBLIC;
REVOKE ALL ON public.store_offline_sales_audit_logs FROM anon, PUBLIC;
REVOKE ALL ON public.go_identity_links FROM anon, PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_monthly_target_plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_daily_targets TO authenticated;
GRANT SELECT ON public.store_target_audit_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.store_offline_sales_entries TO authenticated;
GRANT SELECT ON public.store_offline_sales_audit_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.go_identity_links TO authenticated;

GRANT ALL ON public.store_monthly_target_plans TO service_role;
GRANT ALL ON public.store_daily_targets TO service_role;
GRANT ALL ON public.store_target_audit_logs TO service_role;
GRANT ALL ON public.store_offline_sales_entries TO service_role;
GRANT ALL ON public.store_offline_sales_audit_logs TO service_role;
GRANT ALL ON public.go_identity_links TO service_role;