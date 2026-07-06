
-- Revoke EXECUTE from PUBLIC/anon/authenticated on SECURITY DEFINER functions,
-- then re-grant only where needed (has_role is used inside RLS policies).

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated;',
                   fn.proname, fn.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role;',
                   fn.proname, fn.args);
  END LOOP;
END $$;

-- has_role() is invoked by RLS policies as the querying role; authenticated
-- needs EXECUTE for policies to evaluate.
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
