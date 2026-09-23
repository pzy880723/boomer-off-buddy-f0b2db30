-- commerce_record_order_origin：所有权、非法平台/证据、重放、不覆盖、保留原 metadata、权限。
DO $$
DECLARE c jsonb := public.t_mk_order('origin', 1, 10.00, 0, 10.00);
        o uuid := (c->>'order_id')::uuid; cu uuid := (c->>'customer_id')::uuid; r jsonb; m jsonb; n int;
BEGIN
  UPDATE public.commerce_orders SET metadata = '{"keep":1,"nested":{"a":"b"}}' WHERE id = o;
  BEGIN PERFORM public.commerce_record_order_origin(o, gen_random_uuid(), 'miniapp', 'client_reported');
    RAISE EXCEPTION 'FAIL owner'; EXCEPTION WHEN no_data_found THEN NULL; END;
  BEGIN PERFORM public.commerce_record_order_origin(o, cu, 'delivery', 'client_reported');
    RAISE EXCEPTION 'FAIL delivery'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.commerce_record_order_origin(o, cu, 'web', 'forged');
    RAISE EXCEPTION 'FAIL evidence'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.commerce_record_order_origin(o, cu, 'web', 'verified_miniapp_payment');
    RAISE EXCEPTION 'FAIL verified-non-mini'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  r := public.commerce_record_order_origin(o, cu, 'miniapp', 'verified_miniapp_payment');
  IF r <> '{"version":1,"platform":"miniapp","evidence":"verified_miniapp_payment"}' THEN RAISE EXCEPTION 'FAIL first %', r; END IF;
  r := public.commerce_record_order_origin(o, cu, 'miniapp', 'verified_miniapp_payment');
  r := public.commerce_record_order_origin(o, cu, 'app', 'client_reported');
  IF r->>'platform' <> 'miniapp' THEN RAISE EXCEPTION 'FAIL overwrite %', r; END IF;
  SELECT metadata INTO m FROM public.commerce_orders WHERE id = o;
  IF m->>'keep' <> '1' OR m#>>'{nested,a}' <> 'b' OR m#>>'{sales_origin,platform}' <> 'miniapp' THEN RAISE EXCEPTION 'FAIL meta %', m; END IF;
  SELECT count(*) INTO n FROM public.commerce_order_origin_audit WHERE order_id = o;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL audit %', n; END IF;
  UPDATE public.commerce_orders SET source_channel = 'pos', metadata = '{}' WHERE id = o;
  BEGIN PERFORM public.commerce_record_order_origin(o, cu, 'web', 'client_reported');
    RAISE EXCEPTION 'FAIL pos'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  IF has_function_privilege('anon', 'public.commerce_record_order_origin(uuid,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.commerce_record_order_origin(uuid,uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.commerce_record_order_origin(uuid,uuid,text,text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.commerce_order_origin_audit', 'SELECT')
  THEN RAISE EXCEPTION 'FAIL privileges'; END IF;
  RAISE NOTICE 'PASS 07_record_order_origin';
END $$;
