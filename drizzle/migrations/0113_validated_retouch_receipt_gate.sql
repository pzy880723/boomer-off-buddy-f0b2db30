ALTER TABLE public.inv_defect_retouch_receipts ADD COLUMN validation_version integer NOT NULL DEFAULT 0;
ALTER TABLE public.inv_defect_retouch_receipts ADD COLUMN device_id uuid;
ALTER TABLE public.inv_defect_retouch_receipts ADD COLUMN bound_sku_id uuid;
COMMENT ON COLUMN public.inv_defect_retouch_receipts.validation_version IS '0: untrusted legacy receipt; 1: unchanged quality gates passed and uploaded, not preserved_original. Never backfill legacy receipts.';
REVOKE ALL ON public.inv_defect_retouch_receipts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.inv_defect_retouch_receipts TO service_role;
ALTER TABLE public.inv_defect_retouch_receipts ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.listing_image_has_success_receipt(p_sku uuid,p_path text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT p_path LIKE 'sku-listing/%' AND EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='sku-listing' AND name=substring(p_path FROM 13)) AND (EXISTS(SELECT 1 FROM inv_listing_image_jobs j WHERE j.sku_id=p_sku AND j.status='succeeded' AND 'sku-listing/'||j.target_path=p_path) OR EXISTS(SELECT 1 FROM inv_defect_retouch_receipts t WHERE t.image_path=p_path AND t.source='validated_retouch' AND t.validation_version=1 AND t.actor_user_id IS NOT NULL AND t.device_id IS NOT NULL AND t.bound_sku_id=p_sku))
$$;
CREATE OR REPLACE FUNCTION public.bind_validated_retouch_from_save() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sid uuid; actor uuid; device uuid; paths text[];
BEGIN
IF TG_TABLE_NAME='handheld_item_audit' THEN
 IF NEW.action<>'update' OR NOT ('image_paths'=ANY(NEW.changed_fields)) THEN RETURN NEW; END IF;
 sid:=NEW.sku_id; actor:=NEW.actor_user_id; device:=NEW.device_id;
 SELECT coalesce(array_agg(value),'{}') INTO paths FROM jsonb_array_elements_text(NEW.after_snapshot->'image_paths');
ELSE
 IF NEW.sku_id IS NULL OR NEW.status NOT IN('committed','completed') THEN RETURN NEW; END IF;
 sid:=NEW.sku_id; actor:=NEW.user_id; device:=NEW.device_id;
 SELECT image_paths INTO paths FROM inv_skus WHERE id=sid;
END IF;
UPDATE inv_defect_retouch_receipts t SET bound_sku_id=sid WHERE t.validation_version=1 AND t.source='validated_retouch' AND t.actor_user_id=actor AND t.device_id=device AND t.bound_sku_id IS NULL AND t.image_path=ANY(paths) AND split_part(t.image_path,'/',3)=device::text AND EXISTS(SELECT 1 FROM inv_skus s WHERE s.id=sid AND t.image_path=ANY(s.image_paths)) AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='sku-listing' AND o.name=substring(t.image_path FROM 13));
IF FOUND THEN PERFORM listing_readiness_refresh(sid); END IF;
RETURN NEW;
END $$;
CREATE TRIGGER retouch_bind_edit AFTER INSERT ON public.handheld_item_audit FOR EACH ROW EXECUTE FUNCTION public.bind_validated_retouch_from_save();
CREATE TRIGGER retouch_bind_create AFTER INSERT OR UPDATE OF sku_id,status ON public.handheld_smart_create_ops FOR EACH ROW EXECUTE FUNCTION public.bind_validated_retouch_from_save();
REVOKE ALL ON FUNCTION public.listing_image_has_success_receipt(uuid,text),public.bind_validated_retouch_from_save() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.listing_image_has_success_receipt(uuid,text) TO service_role;
CREATE OR REPLACE FUNCTION public.listing_readiness_is_ready(p_sku uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
SELECT CASE WHEN s.is_custom_price AND coalesce(s.kind,'single')='single' AND coalesce(s.inventory_policy,'tracked')<>'unlimited' THEN coalesce((SELECT r.images_settled AND r.image_plan IS DISTINCT FROM 'raw_declined' AND r.recognition_status='succeeded' AND r.recognition_revision=r.input_revision AND r.image_status='succeeded' AND r.image_revision=r.input_revision AND r.content_status='succeeded' AND r.content_revision=r.input_revision AND cardinality(s.image_paths)>0 AND NOT public.listing_readiness_has_raw(s.image_paths)
AND NOT EXISTS(SELECT 1 FROM unnest(s.image_paths) p WHERE NOT public.listing_image_has_success_receipt(p_sku,p))
AND NOT EXISTS(SELECT 1 FROM inv_listing_image_jobs j WHERE j.sku_id=p_sku AND j.readiness_revision>=r.image_input_revision AND j.status<>'succeeded' AND j.source_bucket||'/'||j.source_path=ANY(s.image_paths))
AND listing_readiness_detail_images_state(p_sku)='succeeded'
AND EXISTS(SELECT 1 FROM inv_product_content c WHERE c.sku_id=p_sku AND c.published_version IS NOT NULL AND jsonb_typeof(c.published_blocks)='array' AND jsonb_array_length(c.published_blocks)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.published_blocks) b WHERE b->>'type'='image' AND (b->>'storage_path' IS NULL OR b->>'storage_path' NOT LIKE 'sku-listing/%' OR NOT EXISTS(SELECT 1 FROM inv_product_content_image_jobs j WHERE j.sku_id=p_sku AND j.block_id=b->>'id' AND j.status='succeeded' AND j.target_path=b->>'storage_path') OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='sku-listing' AND o.name=substring(b->>'storage_path' FROM length('sku-listing/')+1))))) FROM listing_readiness r WHERE r.sku_id=p_sku),false)
ELSE coalesce((SELECT r.images_settled AND r.recognition_status='succeeded' AND r.recognition_revision=r.input_revision AND r.image_status='succeeded' AND r.image_revision=r.input_revision AND r.content_status='succeeded' AND r.content_revision=r.input_revision AND listing_readiness_detail_images_state(p_sku)='succeeded' AND EXISTS(SELECT 1 FROM inv_product_content c WHERE c.sku_id=p_sku AND jsonb_typeof(c.published_blocks)='array' AND jsonb_array_length(c.published_blocks)>0) FROM listing_readiness r WHERE r.sku_id=p_sku),true) END FROM inv_skus s WHERE s.id=p_sku
$$;
CREATE OR REPLACE FUNCTION public.listing_readiness_refresh(p_sku uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r listing_readiness; s inv_skus; v_open int; v_failed int; v_total int; v_err text; v_detail text;
BEGIN
SELECT * INTO r FROM listing_readiness WHERE sku_id=p_sku FOR UPDATE; IF NOT FOUND THEN RETURN jsonb_build_object('status','legacy'); END IF; SELECT * INTO s FROM inv_skus WHERE id=p_sku; r.last_error:=NULL;
IF coalesce(btrim(s.name),'')<>'' AND coalesce(btrim(s.category),'')<>'' THEN r.recognition_status:='succeeded'; ELSE r.recognition_status:='failed'; r.last_error:='missing_category'; END IF;
IF r.image_plan='ai' AND r.image_ai_actor IS NOT NULL AND coalesce(r.image_ai_policy,'')<>'' THEN INSERT INTO inv_listing_image_jobs(sku_id,source_bucket,source_path,source_index,ai_actor_user_id,ai_policy_version,target_bucket,status,next_run_at,readiness_revision) SELECT p_sku,'sku-raw',substring(p FROM length('sku-raw/')+1),(o-1)::int,r.image_ai_actor,r.image_ai_policy,'sku-listing','queued',now(),r.input_revision FROM unnest(s.image_paths) WITH ORDINALITY t(p,o) WHERE p LIKE 'sku-raw/%' ON CONFLICT(sku_id,source_bucket,source_path) DO NOTHING; END IF;
SELECT count(*) FILTER(WHERE status IN('queued','processing','retryable_failed')),count(*) FILTER(WHERE status='permanent_failed'),count(*),max(last_error) FILTER(WHERE status='permanent_failed') INTO v_open,v_failed,v_total,v_err FROM inv_listing_image_jobs WHERE sku_id=p_sku AND readiness_revision>=r.image_input_revision AND (status='succeeded' OR source_bucket||'/'||source_path=ANY(s.image_paths));
IF v_total>0 OR (cardinality(s.image_paths)>0 AND NOT EXISTS(SELECT 1 FROM unnest(s.image_paths) p WHERE NOT listing_image_has_success_receipt(p_sku,p))) THEN r.images_settled:=true; END IF;
IF v_open>0 THEN r.image_status:='running'; ELSIF v_failed>0 THEN r.image_status:='failed'; r.last_error:=coalesce(r.last_error,'image_failed'); ELSIF NOT r.images_settled THEN r.image_status:='pending';
ELSIF (r.image_plan='ai' OR (s.is_custom_price AND coalesce(s.kind,'single')='single' AND coalesce(s.inventory_policy,'tracked')<>'unlimited')) AND listing_readiness_has_raw(s.image_paths) THEN r.image_status:='failed'; r.last_error:=coalesce(r.last_error,'raw_unprocessed');
ELSIF coalesce(array_length(s.image_paths,1),0)>0 OR s.image_url IS NOT NULL THEN r.image_status:='succeeded'; ELSE r.image_status:='failed'; r.last_error:=coalesce(r.last_error,'missing_images'); END IF;
IF s.is_custom_price AND coalesce(s.kind,'single')='single' AND coalesce(s.inventory_policy,'tracked')<>'unlimited' AND r.image_plan='raw_declined' THEN r.image_status:='failed'; r.last_error:='ai_consent_missing'; END IF;
IF s.is_custom_price AND coalesce(s.kind,'single')='single' AND coalesce(s.inventory_policy,'tracked')<>'unlimited' AND r.image_status='succeeded' AND EXISTS(SELECT 1 FROM unnest(s.image_paths) p WHERE NOT public.listing_image_has_success_receipt(p_sku,p)) THEN r.image_status:='failed'; r.last_error:='image_success_receipt_missing'; END IF;
v_detail:=listing_readiness_detail_images_state(p_sku); IF v_detail='failed' THEN r.last_error:=coalesce(r.last_error,'detail_image_failed'); END IF;
UPDATE listing_readiness SET recognition_status=r.recognition_status,recognition_revision=r.input_revision,image_status=r.image_status,image_revision=r.input_revision,images_settled=r.images_settled,last_error=r.last_error,updated_at=now() WHERE sku_id=p_sku;
RETURN jsonb_build_object('status','ok','input_revision',r.input_revision,'recognition',r.recognition_status,'image',r.image_status,'image_plan',r.image_plan,'detail_images',v_detail,'content',r.content_status,'content_revision',r.content_revision,'released',listing_readiness_release(p_sku));
END $$;