-- Additive only. Requires the existing handheld_item_actor / handheld_item_fail helpers.
-- No inventory, short-description, listing-status or recognition writes.
BEGIN;

CREATE TABLE public.inv_product_content (
  sku_id uuid PRIMARY KEY REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  draft_blocks jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(draft_blocks) = 'array'),
  published_blocks jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(published_blocks) = 'array'),
  published_version integer CHECK (published_version > 0 AND published_version <= version),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.inv_product_content_ops (
  device_id uuid NOT NULL,
  client_op_id text NOT NULL,
  user_id uuid NOT NULL,
  location_id uuid NOT NULL,
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  request jsonb NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, client_op_id)
);
ALTER TABLE public.inv_product_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_product_content_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_product_content, public.inv_product_content_ops FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.inv_product_content, public.inv_product_content_ops TO service_role;

-- Keep original references independently of the rendered blocks; never delete raw objects.
CREATE TABLE public.inv_product_content_image_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  block_id text NOT NULL,
  source_path text NOT NULL CHECK (source_path LIKE 'sku-raw/%'),
  target_path text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','processing','retryable_failed','permanent_failed','succeeded','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  claim_token uuid,
  lease_until timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sku_id,block_id,source_path)
);
CREATE INDEX inv_product_content_image_jobs_due ON public.inv_product_content_image_jobs(status,next_run_at);
ALTER TABLE public.inv_product_content_image_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inv_product_content_image_jobs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.inv_product_content_image_jobs TO service_role;

CREATE FUNCTION public.product_content_validate_blocks(p_blocks jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE b jsonb; v_ids text[] := '{}'; v_key text; v_path text;
BEGIN
  IF p_blocks IS NULL OR jsonb_typeof(p_blocks) <> 'array' THEN
    PERFORM public.handheld_item_fail('validation_error', 'blocks must be an array');
  END IF;
  IF jsonb_array_length(p_blocks) > 80 THEN
    PERFORM public.handheld_item_fail('validation_error', 'too many blocks');
  END IF;
  FOR b IN SELECT value FROM jsonb_array_elements(p_blocks) LOOP
    IF jsonb_typeof(b) <> 'object' OR jsonb_typeof(b->'id') IS DISTINCT FROM 'string'
       OR (b->>'id') !~ '^[A-Za-z0-9_-]{1,128}$' OR b->>'id' = ANY(v_ids)
       OR coalesce(b->>'type','') NOT IN ('heading','paragraph','facts','image') THEN
      PERFORM public.handheld_item_fail('validation_error', 'invalid block identity or type');
    END IF;
    v_ids := array_append(v_ids,b->>'id');
    FOR v_key IN SELECT jsonb_object_keys(b) LOOP
      IF v_key NOT IN ('id','type') AND NOT (
        (b->>'type'='image' AND v_key IN ('storage_path','caption')) OR
        (b->>'type'<>'image' AND v_key='text')) THEN
        PERFORM public.handheld_item_fail('validation_error', 'unknown block field');
      END IF;
    END LOOP;
    IF b->>'type'='image' THEN
      v_path := b->>'storage_path';
      IF jsonb_typeof(b->'storage_path') IS DISTINCT FROM 'string' OR length(v_path)>2048
         OR v_path !~ '^sku-(raw|listing)/[A-Za-z0-9_./-]+$'
         OR v_path ~ '(^|/)(\.|\.\.|)(/|$)' THEN
        PERFORM public.handheld_item_fail('validation_error', 'controlled storage path required');
      END IF;
    ELSIF NOT (b ? 'text') THEN
      PERFORM public.handheld_item_fail('validation_error', 'text required');
    END IF;
    FOREACH v_key IN ARRAY ARRAY['text','caption'] LOOP
      IF b ? v_key AND (jsonb_typeof(b->v_key) IS DISTINCT FROM 'string'
        OR length(b->>v_key) NOT BETWEEN 1 AND 4000
        OR b->>v_key ~ '[<>]' OR b->>v_key ~* '(https?://|data:|javascript:)') THEN
        PERFORM public.handheld_item_fail('validation_error', 'plain text required');
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

CREATE FUNCTION public.handheld_product_content(
  p_device_id uuid, p_user_id uuid, p_location_id uuid, p_sku_id uuid, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_actor jsonb; v_sku public.inv_skus; v_content public.inv_product_content;
  v_op public.inv_product_content_ops; v_response jsonb;
  v_action text := p_request->>'action'; v_key text; v_path text; b jsonb;
  v_expected integer; v_publish boolean; v_op_id text; v_version integer;
BEGIN
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
      -- Existing SKU/detail references survive edits on other devices. New images must
      -- exist in storage and belong to this device's upload namespace.
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
      INSERT INTO public.inv_product_content_image_jobs(sku_id,block_id,source_path)
        SELECT p_sku_id,block->>'id',block->>'storage_path'
          FROM jsonb_array_elements(v_content.published_blocks) block
         WHERE block->>'type'='image' AND block->>'storage_path' LIKE 'sku-raw/%'
        ON CONFLICT(sku_id,block_id,source_path) DO UPDATE SET
          status='queued',attempts=0,claim_token=NULL,lease_until=NULL,last_error=NULL,
          next_run_at=now(),updated_at=now()
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
$$;

CREATE FUNCTION public.product_content_image_claim(p_limit integer)
RETURNS SETOF public.inv_product_content_image_jobs
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.inv_product_content_image_jobs SET status='permanent_failed',lease_until=NULL,
    last_error='worker lease expired after final attempt',updated_at=now()
   WHERE status='processing' AND lease_until<now() AND attempts>=5;
  -- Do not spend AI work on deleted, replaced or archived published blocks.
  UPDATE public.inv_product_content_image_jobs j SET status='cancelled',updated_at=now()
   WHERE (j.status IN ('queued','retryable_failed') OR (j.status='processing' AND j.lease_until<now()))
     AND NOT EXISTS (
       SELECT 1 FROM public.inv_product_content c JOIN public.inv_skus s ON s.id=c.sku_id,
         LATERAL jsonb_array_elements(c.published_blocks) b
        WHERE c.sku_id=j.sku_id AND s.status='active' AND s.kind='single' AND s.is_custom_price
          AND b->>'type'='image' AND b->>'id'=j.block_id AND b->>'storage_path'=j.source_path);
  RETURN QUERY
  WITH due AS (
    SELECT id FROM public.inv_product_content_image_jobs
     WHERE attempts<5 AND ((status IN ('queued','retryable_failed') AND next_run_at<=now())
       OR (status='processing' AND lease_until<now()))
     ORDER BY created_at,id LIMIT greatest(1,least(coalesce(p_limit,2),6)) FOR UPDATE SKIP LOCKED
  )
  UPDATE public.inv_product_content_image_jobs j SET status='processing',attempts=j.attempts+1,
    claim_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',updated_at=now()
    FROM due WHERE j.id=due.id RETURNING j.*;
END;
$$;

CREATE FUNCTION public.product_content_image_finish(
  p_id uuid,p_claim_token uuid,p_target_path text,p_error text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_job public.inv_product_content_image_jobs; v_sku public.inv_skus; v_content public.inv_product_content;
  v_draft jsonb; v_published jsonb; v_status text; v_prefix text;
BEGIN
  SELECT * INTO v_job FROM public.inv_product_content_image_jobs WHERE id=p_id;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  -- Same SKU-before-job lock order as publish. Never modify inventory or SKU media.
  SELECT * INTO v_sku FROM public.inv_skus WHERE id=v_job.sku_id FOR UPDATE;
  SELECT * INTO v_job FROM public.inv_product_content_image_jobs WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'processing' OR p_claim_token IS NULL
     OR v_job.claim_token IS DISTINCT FROM p_claim_token OR v_job.lease_until<now() THEN RETURN 'stale'; END IF;
  SELECT * INTO v_content FROM public.inv_product_content WHERE sku_id=v_job.sku_id FOR UPDATE;
  IF NOT FOUND OR v_sku.status IS DISTINCT FROM 'active' OR v_sku.kind IS DISTINCT FROM 'single'
     OR NOT coalesce(v_sku.is_custom_price,false) THEN
    v_status := 'cancelled';
  ELSIF p_error IS NOT NULL THEN
    v_status := CASE WHEN v_job.attempts>=5 THEN 'permanent_failed' ELSE 'retryable_failed' END;
  ELSE
    v_prefix := 'sku-listing/content/'||v_job.sku_id::text||'/'||v_job.id::text||'/'||p_claim_token::text;
    IF p_target_path IS NULL OR p_target_path NOT IN (v_prefix||'.png',v_prefix||'.jpg',v_prefix||'.webp')
       OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='sku-listing'
                       AND name=substring(p_target_path FROM length('sku-listing/')+1)) THEN
      PERFORM public.handheld_item_fail('validation_error','Invalid optimized content image');
    END IF;
    SELECT coalesce(jsonb_agg(CASE WHEN b->>'type'='image' AND b->>'id'=v_job.block_id
      AND b->>'storage_path'=v_job.source_path THEN jsonb_set(b,'{storage_path}',to_jsonb(p_target_path)) ELSE b END ORDER BY ord),'[]')
      INTO v_draft FROM jsonb_array_elements(v_content.draft_blocks) WITH ORDINALITY blocks(b,ord);
    SELECT coalesce(jsonb_agg(CASE WHEN b->>'type'='image' AND b->>'id'=v_job.block_id
      AND b->>'storage_path'=v_job.source_path THEN jsonb_set(b,'{storage_path}',to_jsonb(p_target_path)) ELSE b END ORDER BY ord),'[]')
      INTO v_published FROM jsonb_array_elements(v_content.published_blocks) WITH ORDINALITY blocks(b,ord);
    IF v_draft IS DISTINCT FROM v_content.draft_blocks OR v_published IS DISTINCT FROM v_content.published_blocks THEN
      UPDATE public.inv_product_content SET draft_blocks=v_draft,published_blocks=v_published,
        version=version+1,published_version=CASE WHEN v_published IS DISTINCT FROM v_content.published_blocks
          THEN version+1 ELSE published_version END,updated_at=now() WHERE sku_id=v_job.sku_id;
      v_status := 'succeeded';
    ELSE v_status := 'cancelled'; END IF;
  END IF;
  UPDATE public.inv_product_content_image_jobs SET status=v_status,lease_until=NULL,
    target_path=CASE WHEN p_error IS NULL THEN p_target_path ELSE target_path END,
    last_error=left(p_error,1000),updated_at=now(),
    next_run_at=now()+make_interval(secs=>least(7200,30*power(2,v_job.attempts)::integer))
   WHERE id=p_id;
  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.product_content_image_claim(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.product_content_image_finish(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.product_content_image_claim(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.product_content_image_finish(uuid,uuid,text,text) TO service_role;

-- Server-only: caller must also retain its existing storefront location visibility checks.
CREATE FUNCTION public.published_product_content(p_sku_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT jsonb_build_object('version',c.published_version,'published_blocks',c.published_blocks)
    FROM public.inv_product_content c JOIN public.inv_skus s ON s.id=c.sku_id
   WHERE c.sku_id=p_sku_id AND c.published_version IS NOT NULL
     AND s.status='active' AND s.is_display AND s.is_custom_price AND s.kind='single'
     AND EXISTS (SELECT 1 FROM public.commerce_listings l WHERE l.sku_id=c.sku_id AND l.status='published');
$$;

REVOKE ALL ON FUNCTION public.product_content_validate_blocks(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.handheld_product_content(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.published_product_content(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.product_content_validate_blocks(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_product_content(uuid,uuid,uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.published_product_content(uuid) TO service_role;
COMMIT;
