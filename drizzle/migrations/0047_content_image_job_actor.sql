-- Bind detail-image AI jobs to the publishing session actor + policy version INSIDE the
-- save/publish transaction. Additive: new 6-argument overload; the 5-argument function is
-- left untouched (old callers keep creating actor-less jobs, which the worker never sends to AI).
-- Only jobs inserted or re-queued by THIS transaction get the actor; existing queued/processing
-- jobs from another publisher keep their own actor; historical NULL rows are never claimed.
-- Rollback (each statement separately):
--   DROP FUNCTION IF EXISTS public.handheld_product_content(uuid, uuid, uuid, uuid, jsonb, text);
CREATE OR REPLACE FUNCTION public.handheld_product_content(p_device_id uuid, p_user_id uuid, p_location_id uuid, p_sku_id uuid, p_request jsonb, p_ai_policy_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_actor jsonb; v_sku public.inv_skus; v_content public.inv_product_content;
  v_op public.inv_product_content_ops; v_response jsonb;
  v_action text := p_request->>'action'; v_key text; v_path text; b jsonb;
  v_expected integer; v_publish boolean; v_op_id text; v_version integer;
BEGIN
  IF p_user_id IS NULL OR p_ai_policy_version IS NULL
     OR p_ai_policy_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-v[0-9]+$' THEN
    PERFORM public.handheld_item_fail('validation_error','AI actor context required');
  END IF;
  -- Reuse edit authorization even for reads and idempotent replays.
  v_actor := public.handheld_item_actor(p_user_id,p_location_id);
  IF NOT coalesce((v_actor->>'hq')::boolean,false) AND NOT coalesce((v_actor->>'manager')::boolean,false) THEN
    PERFORM public.handheld_item_fail('edit_forbidden','Item edit permission required');
  END IF;
  IF p_device_id IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
     OR coalesce(v_action,'') NOT IN ('get','save','generate') THEN
    PERFORM public.handheld_item_fail('validation_error','Invalid content action');
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_request) LOOP
    IF v_key NOT IN ('action','location_id') AND NOT
      (v_action='save' AND v_key IN ('expected_version','client_op_id','blocks','publish')) AND NOT
      (v_action='generate' AND v_key='blocks') THEN
      PERFORM public.handheld_item_fail('validation_error','Unexpected request field');
    END IF;
  END LOOP;
  IF p_request ? 'location_id' AND (jsonb_typeof(p_request->'location_id') IS DISTINCT FROM 'string'
      OR lower(p_request->>'location_id') IS DISTINCT FROM p_location_id::text) THEN
    PERFORM public.handheld_item_fail('validation_error','Location mismatch');
  END IF;
  IF v_action='save' THEN
    IF jsonb_typeof(p_request->'expected_version') IS DISTINCT FROM 'number'
       OR (p_request->>'expected_version') !~ '^[0-9]{1,10}$'
       OR (p_request->>'expected_version')::numeric > 2147483646
       OR jsonb_typeof(p_request->'client_op_id') IS DISTINCT FROM 'string'
       OR length(p_request->>'client_op_id') NOT BETWEEN 8 AND 128
       OR NOT (p_request ? 'blocks')
       OR (p_request ? 'publish' AND jsonb_typeof(p_request->'publish') <> 'boolean') THEN
      PERFORM public.handheld_item_fail('validation_error','Save requires version, operation ID and blocks');
    END IF;
    v_expected := (p_request->>'expected_version')::integer;
    v_op_id := p_request->>'client_op_id';
    v_publish := coalesce((p_request->>'publish')::boolean,false);
    PERFORM pg_advisory_xact_lock(hashtextextended('product-content|'||p_device_id::text||'|'||v_op_id,0));
  END IF;

  -- Serialize saves (including the absent content row) without changing SKU timestamps.
  SELECT * INTO v_sku FROM public.inv_skus WHERE id=p_sku_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM public.handheld_item_fail('not_found','SKU not found'); END IF;
  IF v_sku.status IS DISTINCT FROM 'active' THEN PERFORM public.handheld_item_fail('sku_archived','SKU archived'); END IF;
  IF NOT coalesce((v_actor->>'hq')::boolean,false) AND NOT EXISTS (
    SELECT 1 FROM public.inv_stocks WHERE sku_id=p_sku_id AND location_id=p_location_id) THEN
    PERFORM public.handheld_item_fail('location_forbidden','SKU not in this location');
  END IF;
  IF NOT coalesce(v_sku.is_custom_price,false) OR v_sku.kind IS DISTINCT FROM 'single' THEN
    PERFORM public.handheld_item_fail('custom_only','Only custom single products support content');
  END IF;
  IF v_action='save' THEN
    SELECT * INTO v_op FROM public.inv_product_content_ops WHERE device_id=p_device_id AND client_op_id=v_op_id;
    IF FOUND THEN
      IF v_op.user_id IS DISTINCT FROM p_user_id OR v_op.location_id IS DISTINCT FROM p_location_id
         OR v_op.sku_id IS DISTINCT FROM p_sku_id OR v_op.request IS DISTINCT FROM p_request THEN
        PERFORM public.handheld_item_fail('client_op_id_conflict','Operation ID already used for a different immutable payload');
      END IF;
      RETURN v_op.response;
    END IF;
  END IF;
  SELECT * INTO v_content FROM public.inv_product_content WHERE sku_id=p_sku_id;
  v_version := coalesce(v_content.version,0);
  IF p_request ? 'blocks' THEN
    PERFORM public.product_content_validate_blocks(p_request->'blocks');
    FOR b IN SELECT value FROM jsonb_array_elements(p_request->'blocks') WHERE value->>'type'='image' LOOP
      v_path := b->>'storage_path';
      IF NOT coalesce(v_path = ANY(v_sku.image_paths),false) AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(v_content.draft_blocks,'[]')||coalesce(v_content.published_blocks,'[]')) old
         WHERE old->>'type'='image' AND old->>'storage_path'=v_path)
        AND NOT EXISTS (SELECT 1 FROM public.inv_product_content_image_jobs j WHERE j.sku_id=p_sku_id
          AND (j.source_path=v_path OR j.target_path=v_path)) THEN
        IF split_part(v_path,'/',2) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           OR split_part(v_path,'/',3) <> p_device_id::text
           OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id=split_part(v_path,'/',1)
                          AND name=substring(v_path FROM position('/' IN v_path)+1)) THEN
          PERFORM public.handheld_item_fail('image_forbidden','Image does not belong to this SKU or device');
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF v_action='save' THEN
    IF v_expected <> v_version THEN PERFORM public.handheld_item_fail('version_conflict',v_version::text); END IF;
    INSERT INTO public.inv_product_content(sku_id,version,draft_blocks,published_blocks,published_version,updated_by)
      VALUES(p_sku_id,v_version+1,p_request->'blocks',
        CASE WHEN v_publish THEN p_request->'blocks' ELSE coalesce(v_content.published_blocks,'[]') END,
        CASE WHEN v_publish THEN v_version+1 ELSE v_content.published_version END,p_user_id)
      ON CONFLICT(sku_id) DO UPDATE SET version=excluded.version,draft_blocks=excluded.draft_blocks,
        published_blocks=excluded.published_blocks,published_version=excluded.published_version,
        updated_by=excluded.updated_by,updated_at=now()
      RETURNING * INTO v_content;
    v_version := v_content.version;
    IF v_publish THEN
      -- Actor + policy are written in the same statement that creates or re-queues the job.
      INSERT INTO public.inv_product_content_image_jobs(sku_id,block_id,source_path,ai_actor_user_id,ai_policy_version)
        SELECT p_sku_id,block->>'id',block->>'storage_path',p_user_id,p_ai_policy_version
          FROM jsonb_array_elements(v_content.published_blocks) block
         WHERE block->>'type'='image' AND block->>'storage_path' LIKE 'sku-raw/%'
        ON CONFLICT(sku_id,block_id,source_path) DO UPDATE SET
          status='queued',attempts=0,claim_token=NULL,lease_until=NULL,last_error=NULL,
          next_run_at=now(),updated_at=now(),
          ai_actor_user_id=excluded.ai_actor_user_id,ai_policy_version=excluded.ai_policy_version
        WHERE inv_product_content_image_jobs.status IN ('succeeded','cancelled','permanent_failed');
    END IF;
  END IF;
  v_response := jsonb_build_object('version',v_version,'draft_blocks',coalesce(v_content.draft_blocks,'[]'),
    'published_blocks',coalesce(v_content.published_blocks,'[]'));
  IF v_action='save' THEN
    INSERT INTO public.inv_product_content_ops(device_id,client_op_id,user_id,location_id,sku_id,request,response)
      VALUES(p_device_id,v_op_id,p_user_id,p_location_id,p_sku_id,p_request,v_response);
  END IF;
  RETURN v_response;
END;
$function$;
REVOKE ALL ON FUNCTION public.handheld_product_content(uuid, uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_product_content(uuid, uuid, uuid, uuid, jsonb, text) TO service_role;
COMMENT ON FUNCTION public.handheld_product_content(uuid, uuid, uuid, uuid, jsonb, text) IS 'Handheld product content with detail-image jobs bound to the session actor + AI policy version in the same transaction.';