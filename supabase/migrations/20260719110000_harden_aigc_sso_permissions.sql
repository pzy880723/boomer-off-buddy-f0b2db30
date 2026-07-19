-- Keep SSO tickets and cleanup operations server-only even if project defaults
-- grant public-schema privileges to anon/authenticated roles.
REVOKE ALL ON TABLE public.aigc_sso_tickets FROM anon, authenticated;
GRANT ALL ON TABLE public.aigc_sso_tickets TO service_role;

REVOKE ALL ON FUNCTION public.aigc_sso_cleanup_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aigc_sso_cleanup_expired() TO service_role;
