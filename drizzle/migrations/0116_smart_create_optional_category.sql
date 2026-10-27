-- Function-only additive change: no business rows, category constraint, or readiness gates changed.
DO $patch$
DECLARE base text; wrapper text;
BEGIN
base:=pg_get_functiondef('public.handheld_smart_create_commit(uuid,uuid,text,text,uuid,boolean,jsonb,text[],text,uuid)'::regprocedure);
IF position('  IF p_client_op_id IS NOT NULL THEN' IN base)=0 OR position('invalid_required_product_fields' IN base)>0 THEN RAISE EXCEPTION 'unexpected_smart_create_base'; END IF;
base:=replace(base,'  IF p_client_op_id IS NOT NULL THEN',$guard$  -- Only business metadata is optional; required title/price remain valid at the transaction boundary.
  IF coalesce(btrim(p_sku->>'name'),'')='' OR length(p_sku->>'name')>120
     OR jsonb_typeof(p_sku->'price_tier') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'invalid_required_product_fields' USING ERRCODE='22023';
  END IF;
  IF (p_sku->>'price_tier')::numeric < 0.01 OR (p_sku->>'price_tier')::numeric > 999999.99
     OR (p_sku->>'price_tier')::numeric <> round((p_sku->>'price_tier')::numeric,2) THEN
    RAISE EXCEPTION 'invalid_required_product_fields' USING ERRCODE='22023';
  END IF;
  -- Blank means genuinely unclassified in the existing NOT NULL text column, never a taxonomy code.
  p_sku := jsonb_set(p_sku,'{category}',to_jsonb(coalesce(nullif(btrim(p_sku->>'category'),''),'')));

  IF p_client_op_id IS NOT NULL THEN$guard$);
EXECUTE base;
wrapper:=pg_get_functiondef('public.handheld_smart_create_commit_v2(uuid,uuid,text,text,uuid,boolean,jsonb,text[],text,uuid,text,text)'::regprocedure);
IF position('category = p_sku->>''category''' IN wrapper)=0 THEN RAISE EXCEPTION 'unexpected_smart_create_v2'; END IF;
wrapper:=replace(wrapper,'category = p_sku->>''category''','category = coalesce(nullif(btrim(p_sku->>''category''),''''),'''')');
EXECUTE wrapper;
END $patch$;