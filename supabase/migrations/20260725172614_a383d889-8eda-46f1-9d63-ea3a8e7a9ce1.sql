
ALTER FUNCTION public.gen_commerce_order_no() SET search_path = 'public';

CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;
ALTER EXTENSION pg_trgm SET SCHEMA extensions;

ALTER FUNCTION public.search_inv_skus(text, text, uuid[], text[], integer, integer)
  SET search_path = 'public, extensions';

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef = true
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, anon, authenticated',
                   r.nspname, r.proname, r.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role',
                   r.nspname, r.proname, r.args);
  END LOOP;
END$$;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.inv_apply_movement(uuid, uuid, integer, text, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.inv_apply_stock_delta(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gen_stock_transfer_code() TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_after_return_inspection(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_sale(uuid, text, text, uuid, text, text, uuid, jsonb) TO authenticated;
