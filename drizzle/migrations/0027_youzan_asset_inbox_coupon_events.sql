-- 0027: 收件箱接收有赞买家优惠券事件 COUPON_CUSTOMER_PROMOTION。
-- msg_type 白名单；同事件身份内容冲突 → 原记录阻断 payload_conflict 并作废处理租约，待人工检查。
CREATE OR REPLACE FUNCTION public.youzan_asset_inbox_ingest(
  p_kdt_id bigint, p_event_id text, p_msg_type text, p_payload_hash text, p_payload jsonb,
  p_biz_id text DEFAULT NULL, p_msg_version text DEFAULT NULL, p_envelope jsonb DEFAULT NULL,
  p_initial_status text DEFAULT 'pending', p_initial_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_hash text;
BEGIN
  IF p_initial_status NOT IN ('pending','blocked') THEN
    RAISE EXCEPTION 'invalid initial status %', p_initial_status USING ERRCODE = '22023';
  END IF;
  IF p_msg_type NOT IN ('POINTS','COUPON_CUSTOMER_PROMOTION') THEN
    RAISE EXCEPTION 'unsupported msg_type' USING ERRCODE = '22023';
  END IF;
  IF p_msg_version IS NOT NULL AND p_msg_version !~ '^[0-9]{1,19}$' THEN
    RAISE EXCEPTION 'invalid msg_version' USING ERRCODE = '22023';
  END IF;
  INSERT INTO youzan_member_asset_inbox
    (kdt_id, event_id, msg_type, payload_hash, payload, biz_id, msg_version, envelope, status, reason)
  VALUES (p_kdt_id, p_event_id, p_msg_type, p_payload_hash, p_payload, p_biz_id,
    p_msg_version::numeric, p_envelope, p_initial_status, left(p_initial_reason, 200))
  ON CONFLICT (kdt_id, event_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('result','accepted','id',v_id); END IF;
  SELECT id, payload_hash INTO v_id, v_hash FROM youzan_member_asset_inbox
   WHERE kdt_id = p_kdt_id AND event_id = p_event_id FOR UPDATE;
  IF v_hash = p_payload_hash THEN
    UPDATE youzan_member_asset_inbox SET redelivery_count = redelivery_count + 1, updated_at = now() WHERE id = v_id;
    RETURN jsonb_build_object('result','duplicate','id',v_id);
  END IF;
  UPDATE youzan_member_asset_inbox SET conflict_count = conflict_count + 1,
    last_conflict_hash = p_payload_hash, last_conflict_at = now(), updated_at = now(),
    status = 'blocked', reason = 'payload_conflict', claim_token = NULL, lease_until = NULL
   WHERE id = v_id;
  RETURN jsonb_build_object('result','conflict','id',v_id);
END $$;

REVOKE ALL ON FUNCTION public.youzan_asset_inbox_ingest(bigint,text,text,text,jsonb,text,text,jsonb,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_asset_inbox_ingest(bigint,text,text,text,jsonb,text,text,jsonb,text,text) TO service_role;