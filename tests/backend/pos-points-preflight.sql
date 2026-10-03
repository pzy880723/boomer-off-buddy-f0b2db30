-- READ ONLY. No DO, DDL, writes, locks, or business RPC calls.
-- Run this catalog query first. A present function is not proof its body matches.
-- The *_without_points functions/new objects should be absent before first rollout.
WITH required_functions(signature) AS (VALUES
  ('public.pos_complete_sale(uuid,uuid,text,jsonb,jsonb,uuid,text)'),
  ('public.pos_complete_sale_v2(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid)'),
  ('public.pos_complete_return(uuid,uuid,uuid,text,jsonb,text,uuid)'),
  ('public.inv_apply_movement(uuid,uuid,integer,text,uuid,text,text)'),
  ('public.sales_sku_available_qty(uuid,uuid)')
), new_functions(signature) AS (VALUES
  ('public.pos_points_rules(uuid)'),
  ('public.pos_complete_sale_v3(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid,integer)'),
  ('public.pos_recover_sale_cancel(uuid,uuid,text)'),
  ('public.pos_complete_sale_without_points(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid)'),
  ('public.pos_complete_return_without_points(uuid,uuid,uuid,text,jsonb,text,uuid)')
), required_columns(table_name,column_name) AS (VALUES
  ('commerce_membership_plans','id'),('commerce_membership_plans','code'),
  ('commerce_membership_plans','tier_code'),('commerce_membership_plans','is_active'),
  ('commerce_membership_plans','points_redemption_cap_rate'),('commerce_membership_plans','policy_version'),
  ('commerce_membership_entitlements','customer_id'),('commerce_membership_entitlements','plan_id'),
  ('commerce_membership_entitlements','status'),('commerce_membership_entitlements','starts_at'),
  ('commerce_membership_entitlements','expires_at'),
  ('commerce_customers','id'),('commerce_customers','status'),
  ('pos_customer_wallets','customer_id'),('pos_customer_wallets','points'),('pos_customer_wallets','updated_at'),
  ('commerce_points_ledger','customer_id'),('commerce_points_ledger','delta'),
  ('commerce_points_ledger','balance_after'),('commerce_points_ledger','source_type'),
  ('commerce_points_ledger','source_id'),('commerce_points_ledger','idempotency_key'),('commerce_points_ledger','metadata'),
  ('pos_shifts','id'),('pos_shifts','operator_id'),('pos_shifts','location_id'),('pos_shifts','status'),
  ('pos_shifts','register_id'),('pos_registers','id'),('pos_registers','receipt_prefix'),
  ('inv_locations','id'),('inv_locations','kind'),
  ('inv_skus','id'),('inv_skus','price_tier'),('inv_skus','discount_eligible'),('inv_skus','sale_ownership'),
  ('inv_skus','kind'),('inv_skus','is_custom_price'),('inv_skus','inventory_policy'),
  ('inv_stocks','sku_id'),('inv_stocks','location_id'),('inv_stocks','qty'),
  ('commerce_orders','id'),('commerce_orders','order_no'),('commerce_orders','source_channel'),
  ('commerce_orders','idempotency_key'),('commerce_orders','operator_id'),('commerce_orders','pos_shift_id'),
  ('commerce_orders','customer_id'),('commerce_orders','sale_location_id'),('commerce_orders','metadata'),
  ('commerce_orders','subtotal'),('commerce_orders','discount_total'),('commerce_orders','total_amount'),
  ('commerce_orders','benefit_snapshot'),('commerce_orders','discount_snapshot'),
  ('commerce_orders','payment_status'),('commerce_orders','order_status'),
  ('commerce_order_items','id'),('commerce_order_items','order_id'),('commerce_order_items','sku_id'),
  ('commerce_order_items','quantity'),('commerce_order_items','unit_price'),('commerce_order_items','line_total'),
  ('commerce_order_items','discount_total'),('commerce_order_items','discount_snapshot'),
  ('commerce_order_items','original_unit_price'),('commerce_order_items','ownership_snapshot'),
  ('commerce_order_items','category_code'),('commerce_order_items','category_name_snapshot'),
  ('commerce_order_items','subcategory_code'),('commerce_order_items','subcategory_name_snapshot'),
  ('commerce_order_items','created_at'),
  ('pos_receipts','order_id'),('pos_receipts','payload'),
  ('pos_returns','id'),('pos_returns','order_id'),('pos_returns','shift_id'),('pos_returns','operator_id'),
  ('pos_returns','client_op_id'),('pos_returns','refund_total'),('pos_returns','status'),('pos_returns','completed_at'),
  ('pos_return_items','return_id'),('pos_return_items','order_item_id'),('pos_return_items','quantity'),
  ('pos_return_items','refund_amount'),
  ('pos_authorizations','id'),('pos_authorizations','operator_id'),('pos_authorizations','authorizer_id'),
  ('pos_authorizations','location_id'),('pos_authorizations','action'),('pos_authorizations','status'),
  ('pos_authorizations','expires_at'),('user_roles','user_id'),('user_roles','role')
), relevant_relations AS (
  SELECT c.oid,c.relname,c.relrowsecurity FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND
    (c.relname IN (SELECT DISTINCT table_name FROM required_columns)
     OR c.relname IN ('pos_sale_cancellations','commerce_payments','commerce_payment_events',
       'pos_cash_movements','inventory_reservations','inventory_reservation_lines','inv_stock_movements'))
), relevant_functions AS (
  SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN (
    'pos_complete_sale','pos_complete_sale_v2','pos_complete_sale_v3','pos_points_rules',
    'pos_recover_sale_cancel','pos_complete_sale_without_points','pos_complete_return_without_points',
    'pos_complete_return','inv_apply_movement','sales_sku_available_qty','sync_handheld_custom_listing')
)
SELECT jsonb_build_object(
  'captured_at',clock_timestamp(),
  'database',current_database(),
  'server_version',current_setting('server_version'),
  'query_transaction_isolation',current_setting('transaction_isolation'),
  'default_transaction_isolation',current_setting('default_transaction_isolation'),
  'migration_history_relation',to_regclass('supabase_migrations.schema_migrations')::text,
  'missing_required_functions',coalesce((SELECT jsonb_agg(signature) FROM required_functions
    WHERE to_regprocedure(signature) IS NULL),'[]'::jsonb),
  'new_function_presence',(SELECT jsonb_agg(jsonb_build_object('signature',signature,'present',to_regprocedure(signature) IS NOT NULL)) FROM new_functions),
  'new_table_present',to_regclass('public.pos_sale_cancellations') IS NOT NULL,
  'new_plan_columns',(SELECT coalesce(jsonb_agg(column_name),'[]'::jsonb) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='commerce_membership_plans' AND column_name IN
      ('points_redemption_enabled','points_redemption_points_per_unit','points_redemption_unit_fen')),
  'missing_required_columns',coalesce((SELECT jsonb_agg(r.table_name||'.'||r.column_name) FROM required_columns r
    WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public'
      AND c.table_name=r.table_name AND c.column_name=r.column_name)),'[]'::jsonb),
  'functions',(SELECT jsonb_agg(jsonb_build_object(
    'name',p.proname,'identity_arguments',pg_get_function_identity_arguments(p.oid),
    'result_type',pg_get_function_result(p.oid),'owner',pg_get_userbyid(p.proowner),
    'security_definer',p.prosecdef,'settings',p.proconfig,'body_md5',md5(p.prosrc),
    'service_role_execute',CASE WHEN sr.oid IS NOT NULL THEN has_function_privilege(sr.oid,p.oid,'EXECUTE') ELSE NULL END,
    'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN acl.grantee=0 THEN 'PUBLIC'
      ELSE pg_get_userbyid(acl.grantee) END,'privilege',acl.privilege_type))
      FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl)
    ) ORDER BY p.proname,p.oid) FROM relevant_functions p LEFT JOIN pg_roles sr ON sr.rolname='service_role'),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',c.conname,
    'definition',pg_get_constraintdef(c.oid),'validated',c.convalidated))
    FROM pg_constraint c JOIN relevant_relations r ON r.oid=c.conrelid),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('table',r.relname,'definition',pg_get_indexdef(i.indexrelid),
    'valid',i.indisvalid,'unique',i.indisunique)) FROM pg_index i JOIN relevant_relations r ON r.oid=i.indrelid),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',t.tgname,
    'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)))
    FROM pg_trigger t JOIN relevant_relations r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal),
  'isolation_overrides',(SELECT jsonb_agg(jsonb_build_object('role',coalesce(pr.rolname,'ALL'),
    'database',coalesce(d.datname,'ALL'),'setting',cfg.value)) FROM pg_db_role_setting s
    LEFT JOIN pg_roles pr ON pr.oid=s.setrole LEFT JOIN pg_database d ON d.oid=s.setdatabase
    CROSS JOIN LATERAL unnest(s.setconfig) cfg(value)
    WHERE cfg.value LIKE 'default_transaction_isolation=%')
) AS pos_points_preflight;
