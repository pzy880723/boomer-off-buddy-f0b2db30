
-- 1) Pin search_path on the only remaining mutable function
ALTER FUNCTION public.gen_commerce_after_sale_no() SET search_path = public;

-- 2) Revoke EXECUTE from PUBLIC/anon/authenticated on all SECURITY DEFINER
--    functions in public schema, except has_role (used by RLS policies and
--    therefore must remain executable by authenticated).
DO $$
DECLARE
  r record;
  sig text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.proname <> 'has_role'
  LOOP
    sig := format('public.%I(%s)', r.proname, r.args);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END$$;
