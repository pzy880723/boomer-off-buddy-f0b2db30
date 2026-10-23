-- Photo listing: atomic cancel/recover tombstone + v3 wrapper that saves featured_stamp/notice_tags in the commit transaction.
-- handheld_smart_create_commit / _v2 bodies are untouched (image plan, readiness, outbox and worker paths unchanged).
ALTER TABLE public.handheld_smart_create_ops ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.handheld_smart_create_ops DROP CONSTRAINT IF EXISTS handheld_smart_create_ops_status_check;
ALTER TABLE public.handheld_smart_create_ops ADD CONSTRAINT handheld_smart_create_ops_status_check
  CHECK (status = ANY (ARRAY['committed'::text, 'completed'::text, 'cancelled'::text]));
ALTER TABLE public.handheld_smart_create_ops DROP CONSTRAINT IF EXISTS handheld_smart_create_ops_cancelled_no_sku;
ALTER TABLE public.handheld_smart_create_ops ADD CONSTRAINT handheld_smart_create_ops_cancelled_no_sku
  CHECK (status <> 'cancelled' OR (sku_id IS NULL AND cancelled_at IS NOT NULL));
COMMENT ON COLUMN public.handheld_smart_create_ops.cancelled_at IS 'Tombstone: set only when the op was proven absent under the op lock; any later commit with this op is rejected and creates no SKU.';

-- Cancel or recover one op. Serialized with v3 by the same advisory key and with every legacy caller by the
-- (device_id, client_op_id) unique index: an in-flight commit makes this INSERT wait until it commits or rolls back.
CREATE OR REPLACE FUNCTION public.handheld_smart_create_cancel(p_device_id uuid, p_user_id uuid, p_client_op_id text,
  p_fingerprint text, p_location_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_op public.handheld_smart_create_ops;
BEGIN
  IF p_device_id IS NULL OR p_user_id IS NULL OR p_location_id IS NULL OR coalesce(p_fingerprint,'') = ''
     OR coalesce(btrim(p_client_op_id),'') = '' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('hh-smart-create:' || p_device_id || ':' || p_client_op_id, 0));
  INSERT INTO public.handheld_smart_create_ops (device_id, client_op_id, user_id, location_id, payload_fingerprint, status, cancelled_at)
  VALUES (p_device_id, p_client_op_id, p_user_id, p_location_id, p_fingerprint, 'cancelled', now())
  ON CONFLICT (device_id, client_op_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('state', 'cancelled', 'op_id', v_id, 'replayed', false, 'sku_id', NULL, 'response', NULL);
  END IF;
  SELECT * INTO v_op FROM public.handheld_smart_create_ops
   WHERE device_id = p_device_id AND client_op_id = p_client_op_id FOR UPDATE;
  IF v_op.user_id <> p_user_id OR v_op.location_id <> p_location_id OR v_op.payload_fingerprint <> p_fingerprint THEN
    RAISE EXCEPTION 'client_op_id_conflict' USING ERRCODE = 'P0409';
  END IF;
  RETURN jsonb_build_object('state', v_op.status, 'op_id', v_op.id, 'replayed', true, 'sku_id', v_op.sku_id,
    'response', v_op.response_json);
END $function$;

-- v3 = same signature as v2 + optional marks. Rejects tombstoned ops under the op lock, then delegates to the unchanged v2.
-- Marks are written only for a newly created SKU in this transaction; replays and reused SKUs never overwrite later edits.
CREATE OR REPLACE FUNCTION public.handheld_smart_create_commit_v3(p_device_id uuid, p_user_id uuid, p_client_op_id text,
  p_fingerprint text, p_location_id uuid, p_reuse boolean, p_sku jsonb, p_epcs text[], p_note text, p_release_shop_id uuid,
  p_image_plan text, p_ai_policy text, p_marks jsonb DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v jsonb; v_op public.handheld_smart_create_ops; v_sku uuid; v_tags text[]; v_applied boolean := false;
BEGIN
  IF p_marks IS NOT NULL THEN
    IF jsonb_typeof(p_marks) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_marks) k WHERE k NOT IN ('featured_stamp','notice_tags')) THEN
      RAISE EXCEPTION 'invalid_product_marks' USING ERRCODE = '22023';
    END IF;
    IF p_marks ? 'featured_stamp' AND jsonb_typeof(p_marks->'featured_stamp') NOT IN ('null','string') THEN
      RAISE EXCEPTION 'invalid_product_marks' USING ERRCODE = '22023';
    END IF;
    IF p_marks ? 'notice_tags' THEN
      IF jsonb_typeof(p_marks->'notice_tags') <> 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_marks->'notice_tags') e WHERE jsonb_typeof(e) <> 'string') THEN
        RAISE EXCEPTION 'invalid_product_marks' USING ERRCODE = '22023';
      END IF;
      v_tags := ARRAY(SELECT jsonb_array_elements_text(p_marks->'notice_tags'));
      IF NOT public.inv_notice_tags_valid(v_tags) THEN RAISE EXCEPTION 'invalid_product_marks' USING ERRCODE = '22023'; END IF;
      v_tags := public.inv_notice_tags_normalize(v_tags);
    END IF;
  END IF;
  IF p_client_op_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hh-smart-create:' || p_device_id || ':' || p_client_op_id, 0));
    SELECT * INTO v_op FROM public.handheld_smart_create_ops WHERE device_id = p_device_id AND client_op_id = p_client_op_id;
    IF FOUND AND v_op.status = 'cancelled' THEN
      IF v_op.user_id <> p_user_id OR v_op.location_id <> p_location_id OR v_op.payload_fingerprint <> p_fingerprint THEN
        RAISE EXCEPTION 'client_op_id_conflict' USING ERRCODE = 'P0409';
      END IF;
      RAISE EXCEPTION 'client_op_cancelled' USING ERRCODE = 'P0410';
    END IF;
  END IF;
  v := public.handheld_smart_create_commit_v2(p_device_id, p_user_id, p_client_op_id, p_fingerprint, p_location_id,
    p_reuse, p_sku, p_epcs, p_note, p_release_shop_id, p_image_plan, p_ai_policy);
  IF v->>'op_status' = 'cancelled' THEN RAISE EXCEPTION 'client_op_cancelled' USING ERRCODE = 'P0410'; END IF;
  v_sku := NULLIF(v->>'sku_id','')::uuid;
  IF p_marks IS NOT NULL AND v_sku IS NOT NULL AND NOT coalesce((v->>'replayed')::boolean, false)
     AND NOT coalesce((v->>'reused')::boolean, false) THEN
    UPDATE public.inv_skus SET
      featured_stamp = CASE WHEN p_marks ? 'featured_stamp' THEN p_marks->>'featured_stamp' ELSE featured_stamp END,
      notice_tags = CASE WHEN p_marks ? 'notice_tags' THEN v_tags ELSE notice_tags END
     WHERE id = v_sku;
    v_applied := true;
  END IF;
  RETURN v || jsonb_build_object('marks_applied', v_applied);
END $function$;

REVOKE ALL ON FUNCTION public.handheld_smart_create_cancel(uuid,uuid,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handheld_smart_create_commit_v3(uuid,uuid,text,text,uuid,boolean,jsonb,text[],text,uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handheld_smart_create_cancel(uuid,uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.handheld_smart_create_commit_v3(uuid,uuid,text,text,uuid,boolean,jsonb,text[],text,uuid,text,text,jsonb) TO service_role;
