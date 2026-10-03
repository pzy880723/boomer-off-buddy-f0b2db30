-- READ ONLY. Inspect live hotfixes before trusting a matching signature/hash.
SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  md5(p.prosrc) AS body_md5,pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN (
  'pos_complete_sale','pos_complete_sale_v2','pos_complete_return',
  'inv_apply_movement','sales_sku_available_qty','sync_handheld_custom_listing'
) ORDER BY p.proname,p.oid;
