-- SECURITY DEFINER functions must not inherit PostgreSQL's default PUBLIC execute grant.
REVOKE ALL ON FUNCTION public.commerce_reserve_recognition_quota(uuid, text, date)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.commerce_reserve_recognition_quota(uuid, text, date)
  TO service_role;
