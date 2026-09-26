BEGIN;

ALTER TABLE public.stock_transfers DROP CONSTRAINT stock_transfers_kind_check;
ALTER TABLE public.stock_transfers ADD CONSTRAINT stock_transfers_kind_check
  CHECK(kind IN ('wh_to_shop','shop_to_shop','shop_to_wh','consume','custom'));
ALTER TABLE public.stock_transfers ADD COLUMN client_op_id text,
  ADD COLUMN request_snapshot jsonb;
CREATE UNIQUE INDEX stock_transfers_custom_operation ON public.stock_transfers(shipped_by,client_op_id)
  WHERE kind='custom';
ALTER TABLE public.stock_transfer_lines ADD COLUMN source_sync_id uuid REFERENCES public.youzan_stock_sync_queue(id);

CREATE TABLE public.stock_transfer_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.stock_transfers(id),
  uploaded_by uuid NOT NULL,
  storage_path text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
ALTER TABLE public.stock_transfer_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_transfer_receipts FROM anon,authenticated;
GRANT ALL ON public.stock_transfer_receipts TO service_role;
CREATE FUNCTION public.custom_transfer_is_legacy(p_id uuid) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM public.stock_transfers WHERE id=p_id AND kind<>'custom');
$$;
REVOKE ALL ON FUNCTION public.custom_transfer_is_legacy(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.custom_transfer_is_legacy(uuid) TO authenticated,service_role;
-- Existing legacy policies are permissive. Custom records are API-only so raw
-- authenticated table writes cannot bypass the transactional receipt workflow.
CREATE POLICY custom_transfers_api_only ON public.stock_transfers AS RESTRICTIVE
  FOR ALL TO authenticated USING(kind<>'custom') WITH CHECK(kind<>'custom');
CREATE POLICY custom_transfer_lines_api_only ON public.stock_transfer_lines AS RESTRICTIVE
  FOR ALL TO authenticated USING(public.custom_transfer_is_legacy(transfer_id))
  WITH CHECK(public.custom_transfer_is_legacy(transfer_id));

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('transfer-receipts','transfer-receipts',false,5242880,ARRAY['image/jpeg','image/png'])
ON CONFLICT(id) DO NOTHING;

CREATE FUNCTION public.custom_transfer_is_hq(p_user uuid) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=p_user AND role::text IN ('super_admin','hq_operator'));
$$;
CREATE FUNCTION public.custom_transfer_can_access(p_user uuid,p_location uuid) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=public AS $$
  SELECT public.custom_transfer_is_hq(p_user) OR EXISTS(
    SELECT 1 FROM public.user_location_perms WHERE user_id=p_user AND location_id=p_location);
$$;
CREATE FUNCTION public.custom_transfer_reserved(p_sku uuid,p_location uuid) RETURNS bigint LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=public AS $$
  SELECT coalesce(sum(qty),0) FROM (
    SELECT l.quantity AS qty FROM public.inventory_reservation_lines l
      JOIN public.inventory_reservations r ON r.id=l.reservation_id
      WHERE l.stock_sku_id=p_sku AND l.location_id=p_location AND r.status='active'
    UNION ALL
    SELECT r.quantity FROM public.inventory_reservations r
      WHERE r.sku_id=p_sku AND r.location_id=p_location AND r.status='active'
      AND NOT EXISTS(SELECT 1 FROM public.inventory_reservation_lines l WHERE l.reservation_id=r.id)
  ) holds;
$$;

CREATE FUNCTION public.custom_transfer_create(p_user uuid,p_operation text,p_from uuid,p_to uuid,p_note text,p_lines jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  t public.stock_transfers; src public.inv_locations; dest public.inv_locations;
  line record; sku public.inv_skus; n int; total int; source_job uuid; snapshot jsonb;
BEGIN
  IF NOT public.custom_transfer_is_hq(p_user) THEN RAISE EXCEPTION 'transfer_create_forbidden'; END IF;
  IF p_from=p_to THEN RAISE EXCEPTION 'same_location'; END IF;
  IF coalesce(length(p_operation),0) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_operation'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines)<>'array' THEN RAISE EXCEPTION 'invalid_lines'; END IF;
  IF jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_lines'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_to_recordset(p_lines) AS l(sku_id uuid,qty int) WHERE sku_id IS NULL OR qty IS NULL OR qty<1 OR qty>10000)
    OR (SELECT count(*)<>count(DISTINCT sku_id) FROM jsonb_to_recordset(p_lines) AS l(sku_id uuid,qty int))
    THEN RAISE EXCEPTION 'invalid_lines'; END IF;
  SELECT jsonb_build_object('from',p_from,'to',p_to,'note',coalesce(p_note,''),'lines',
    jsonb_agg(jsonb_build_object('sku_id',sku_id,'qty',qty) ORDER BY sku_id)),sum(qty)
    INTO snapshot,total FROM jsonb_to_recordset(p_lines) AS l(sku_id uuid,qty int);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user::text||':'||p_operation,0));
  SELECT * INTO t FROM public.stock_transfers WHERE kind='custom' AND shipped_by=p_user AND client_op_id=p_operation;
  IF FOUND THEN
    IF t.request_snapshot IS DISTINCT FROM snapshot THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
    RETURN jsonb_build_object('id',t.id,'code',t.code,'status',t.status,'replayed',true);
  END IF;
  SELECT * INTO src FROM public.inv_locations WHERE id=p_from AND is_active;
  SELECT * INTO dest FROM public.inv_locations WHERE id=p_to AND is_active;
  IF src.id IS NULL OR dest.id IS NULL THEN RAISE EXCEPTION 'invalid_location'; END IF;

  INSERT INTO public.stock_transfers(kind,status,qty,from_location_id,to_location_id,from_shop_id,to_shop_id,
    notes,shipped_by,shipped_at,client_op_id,request_snapshot,youzan_sync_status)
  VALUES('custom','in_transit',total,p_from,p_to,src.shop_id,dest.shop_id,p_note,p_user,now(),p_operation,snapshot,
    CASE WHEN src.shop_id IS NULL AND dest.shop_id IS NULL THEN 'not_required' ELSE 'pending' END) RETURNING * INTO t;
  FOR line IN SELECT * FROM jsonb_to_recordset(p_lines) AS l(sku_id uuid,qty int) ORDER BY sku_id LOOP
    -- Orders acquire listing locks before stock locks. Match that ordering and
    -- serialize against reservations before evaluating availability.
    PERFORM 1 FROM public.commerce_listings WHERE sku_id=line.sku_id ORDER BY id FOR UPDATE;
    SELECT * INTO sku FROM public.inv_skus WHERE id=line.sku_id FOR UPDATE;
    IF sku.id IS NULL OR NOT sku.is_custom_price OR sku.kind<>'single' OR sku.inventory_policy<>'tracked'
      OR sku.status<>'active' THEN RAISE EXCEPTION 'custom_only'; END IF;
    SELECT qty INTO n FROM public.inv_stocks WHERE sku_id=line.sku_id AND location_id=p_from FOR UPDATE;
    IF coalesce(n,0)<line.qty THEN RAISE EXCEPTION 'stock_unavailable'; END IF;
    IF public.custom_transfer_reserved(line.sku_id,p_from)>0 THEN RAISE EXCEPTION 'stock_reserved'; END IF;
    IF n<>line.qty OR EXISTS(SELECT 1 FROM public.inv_stocks WHERE sku_id=line.sku_id AND location_id<>p_from AND qty>0)
      THEN RAISE EXCEPTION 'whole_custom_item_required'; END IF;
    IF EXISTS(SELECT 1 FROM public.inv_epcs WHERE sku_id=line.sku_id AND status IN ('in_stock','in_transit'))
      THEN RAISE EXCEPTION 'rfid_transfer_required'; END IF;
    IF EXISTS(SELECT 1 FROM public.stock_transfer_lines l JOIN public.stock_transfers x ON x.id=l.transfer_id
      WHERE l.sku_id=line.sku_id AND x.status IN ('draft','in_transit')) THEN RAISE EXCEPTION 'already_in_transit'; END IF;
    -- Do not race an already-sent source-channel request. Pending claims lock
    -- these rows and will see the new revision / cancelled release after commit.
    PERFORM 1 FROM public.youzan_stock_sync_queue WHERE sku_id=line.sku_id AND shop_id=src.shop_id FOR UPDATE;
    PERFORM 1 FROM public.handheld_youzan_release_outbox WHERE sku_id=line.sku_id AND shop_id=src.shop_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.youzan_stock_sync_queue WHERE sku_id=line.sku_id AND shop_id=src.shop_id AND status='running')
      OR EXISTS(SELECT 1 FROM public.handheld_youzan_release_outbox WHERE sku_id=line.sku_id AND shop_id=src.shop_id AND status='processing')
      THEN RAISE EXCEPTION 'source_sync_busy'; END IF;
    PERFORM public.inv_apply_movement(line.sku_id,p_from,-line.qty,'transfer_out',t.id,NULL,p_note);
    UPDATE public.inv_stock_movements SET created_by=p_user WHERE ref_id=t.id AND sku_id=line.sku_id AND ref_type='transfer_out';
    UPDATE public.commerce_listings SET status='hidden',updated_at=now() WHERE sku_id=line.sku_id AND location_id=p_from AND status NOT IN ('archived','sold');
    UPDATE public.handheld_youzan_release_outbox SET status='cancelled',last_error='custom_transfer_out',updated_at=now()
      WHERE sku_id=line.sku_id AND shop_id=src.shop_id AND status IN ('pending','failed');
    source_job:=NULL;
    IF src.shop_id IS NOT NULL THEN
      INSERT INTO public.youzan_stock_sync_queue(sku_id,shop_id,location_id,target_stock,reason,action)
        VALUES(line.sku_id,src.shop_id,p_from,0,'custom_transfer_out:'||t.id,'update_stock')
        ON CONFLICT(sku_id,shop_id) WHERE status IN ('pending','failed') DO UPDATE SET
          location_id=excluded.location_id,target_stock=0,reason=excluded.reason,action='update_stock',
          status='pending',attempts=0,next_run_at=now(),last_error=NULL,updated_at=now()
        RETURNING id INTO source_job;
    END IF;
    INSERT INTO public.stock_transfer_lines(transfer_id,sku_id,expected_qty,shipped_qty,received_qty,source_sync_id)
      VALUES(t.id,line.sku_id,line.qty,line.qty,0,source_job);
  END LOOP;
  RETURN jsonb_build_object('id',t.id,'code',t.code,'status',t.status,'replayed',false);
END;
$$;

CREATE FUNCTION public.custom_transfer_receive(p_user uuid,p_transfer uuid,p_photos uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t public.stock_transfers; dest public.inv_locations; line public.stock_transfer_lines; sku public.inv_skus;
BEGIN
  SELECT * INTO t FROM public.stock_transfers WHERE id=p_transfer AND kind='custom' FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'transfer_not_found'; END IF;
  IF NOT public.custom_transfer_can_access(p_user,t.to_location_id) THEN RAISE EXCEPTION 'transfer_receive_forbidden'; END IF;
  IF t.status='received' THEN RETURN jsonb_build_object('id',t.id,'status',t.status,'replayed',true); END IF;
  IF t.status<>'in_transit' THEN RAISE EXCEPTION 'transfer_not_in_transit'; END IF;
  IF coalesce(cardinality(p_photos),0) NOT BETWEEN 1 AND 6 THEN RAISE EXCEPTION 'receipt_required'; END IF;
  IF (SELECT count(*) FROM public.stock_transfer_receipts r WHERE r.id=ANY(p_photos) AND r.transfer_id=t.id
       AND r.uploaded_by=p_user AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='transfer-receipts' AND o.name=r.storage_path))<>cardinality(p_photos)
    THEN RAISE EXCEPTION 'receipt_missing'; END IF;
  SELECT * INTO dest FROM public.inv_locations WHERE id=t.to_location_id AND is_active;
  IF dest.id IS NULL THEN RAISE EXCEPTION 'invalid_location'; END IF;
  FOR line IN SELECT * FROM public.stock_transfer_lines WHERE transfer_id=t.id ORDER BY sku_id FOR UPDATE LOOP
    SELECT * INTO sku FROM public.inv_skus WHERE id=line.sku_id FOR UPDATE;
    IF sku.status<>'active' THEN RAISE EXCEPTION 'custom_only'; END IF;
    IF line.source_sync_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.youzan_stock_sync_queue
      WHERE id=line.source_sync_id AND status='done' AND target_stock=0) THEN RAISE EXCEPTION 'source_sync_pending'; END IF;
    IF EXISTS(SELECT 1 FROM public.youzan_stock_sync_queue WHERE sku_id=line.sku_id AND shop_id=t.from_shop_id AND status='running')
      OR EXISTS(SELECT 1 FROM public.handheld_youzan_release_outbox WHERE sku_id=line.sku_id AND shop_id=t.from_shop_id AND status='processing')
      THEN RAISE EXCEPTION 'source_sync_pending'; END IF;
    IF EXISTS(SELECT 1 FROM public.inv_stocks WHERE sku_id=line.sku_id AND qty>0) THEN RAISE EXCEPTION 'unexpected_stock'; END IF;
    PERFORM public.inv_apply_movement(line.sku_id,t.to_location_id,line.shipped_qty,'transfer_in',t.id,NULL,'photo receipt');
    UPDATE public.inv_stock_movements SET created_by=p_user WHERE ref_id=t.id AND sku_id=line.sku_id AND ref_type='transfer_in';
    UPDATE public.stock_transfer_lines SET received_qty=shipped_qty WHERE transfer_id=t.id AND sku_id=line.sku_id;
    IF dest.kind='shop' THEN
      INSERT INTO public.commerce_listings(sku_id,location_id,title,description,price,condition_grade,category,image_paths,status,product_type,published_at,created_by,updated_at)
      VALUES(sku.id,dest.id,sku.name,sku.notes,sku.price_tier,sku.grade,sku.category,to_jsonb(sku.image_paths),
        CASE WHEN sku.is_display THEN 'published' ELSE 'hidden' END,'custom',now(),p_user,now())
      ON CONFLICT(sku_id,location_id) DO UPDATE SET title=excluded.title,description=excluded.description,price=excluded.price,
        condition_grade=excluded.condition_grade,category=excluded.category,image_paths=excluded.image_paths,status=excluded.status,updated_at=now();
    END IF;
    IF dest.shop_id IS NOT NULL THEN
      INSERT INTO public.handheld_youzan_release_outbox(sku_id,shop_id,location_id)
      VALUES(sku.id,dest.shop_id,dest.id) ON CONFLICT(sku_id,shop_id) DO UPDATE SET
        status=CASE WHEN handheld_youzan_release_outbox.status='processing' THEN 'processing' ELSE 'pending' END,
        next_attempt_at=now(),location_id=excluded.location_id,last_error=NULL,updated_at=now();
    END IF;
  END LOOP;
  UPDATE public.stock_transfer_receipts SET used_at=now() WHERE id=ANY(p_photos);
  UPDATE public.stock_transfers SET status='received',received_by=p_user,received_at=now(),updated_at=now() WHERE id=t.id;
  RETURN jsonb_build_object('id',t.id,'status','received','replayed',false);
END;
$$;

REVOKE ALL ON FUNCTION public.custom_transfer_is_hq(uuid),public.custom_transfer_can_access(uuid,uuid),public.custom_transfer_reserved(uuid,uuid),
  public.custom_transfer_create(uuid,text,uuid,uuid,text,jsonb),public.custom_transfer_receive(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.custom_transfer_is_hq(uuid),public.custom_transfer_can_access(uuid,uuid),public.custom_transfer_reserved(uuid,uuid),
  public.custom_transfer_create(uuid,text,uuid,uuid,text,jsonb),public.custom_transfer_receive(uuid,uuid,uuid[]) TO service_role;
CREATE FUNCTION public.custom_transfer_products(p_user uuid,p_location uuid,p_query text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.custom_transfer_is_hq(p_user) THEN RAISE EXCEPTION 'transfer_create_forbidden'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.inv_locations WHERE id=p_location AND is_active) THEN RAISE EXCEPTION 'invalid_location'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
    SELECT s.id AS sku_id,s.name,coalesce(s.sku_code,'') AS sku_code,coalesce(s.barcode,'') AS barcode,
      s.price_tier AS price,st.qty,st.qty AS available_qty,''::text AS image_url
    FROM public.inv_stocks st JOIN public.inv_skus s ON s.id=st.sku_id
    WHERE st.location_id=p_location AND st.qty>0 AND s.is_custom_price AND s.kind='single' AND s.inventory_policy='tracked'
      AND s.status='active' AND public.custom_transfer_reserved(s.id,p_location)=0
      AND NOT EXISTS(SELECT 1 FROM public.inv_stocks other WHERE other.sku_id=s.id AND other.location_id<>p_location AND other.qty>0)
      AND NOT EXISTS(SELECT 1 FROM public.inv_epcs e WHERE e.sku_id=s.id AND e.status IN ('in_stock','in_transit'))
      AND (coalesce(p_query,'')='' OR position(lower(p_query) IN lower(s.name||' '||coalesce(s.sku_code,'')||' '||coalesce(s.barcode,'')))>0)
    ORDER BY s.name,s.id LIMIT 100
  ) x),'[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.custom_transfer_products(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.custom_transfer_products(uuid,uuid,text) TO service_role;
COMMIT;
