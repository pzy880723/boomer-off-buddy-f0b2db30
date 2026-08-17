REVOKE ALL ON FUNCTION public.commerce_reserve_recognition_quota(uuid, text, date)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.commerce_reserve_recognition_quota(uuid, text, date)
  TO service_role;
