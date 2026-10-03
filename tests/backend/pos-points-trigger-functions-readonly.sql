-- READ ONLY: function definitions/ACL only, no customer or transaction rows.
-- Includes every currently attached trigger on the tables touched by these RPCs.
SELECT DISTINCT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
  p.proconfig AS settings, p.proacl::text AS acl, md5(p.prosrc) AS body_md5,
  pg_get_functiondef(p.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_proc p ON p.oid=t.tgfoid
WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname IN (
  'commerce_orders','commerce_order_items','commerce_payments','commerce_payment_events',
  'pos_shifts','pos_registers','pos_receipts','pos_cash_movements',
  'pos_customer_wallets','commerce_points_ledger','pos_returns','pos_return_items',
  'inv_stocks','inv_stock_movements','inv_skus','inv_epcs','commerce_listings'
)
ORDER BY p.proname, arguments;
