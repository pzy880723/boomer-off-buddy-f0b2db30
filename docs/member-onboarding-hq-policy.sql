CREATE OR REPLACE FUNCTION public.member_onboarding_finish(p_shop_id uuid,p_revision integer,p_token uuid,p_status text,p_reason text,p_checks jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j public.member_onboarding_jobs%ROWTYPE; loc uuid; loc_count integer; notice_key text; safe_checks jsonb;
BEGIN
 IF p_status NOT IN ('blocked','configuration_verified','verified') OR p_reason NOT IN
 ('hq_ownership_unverified','token_unavailable','member_mapping_incomplete','rule_semantics_unverified','pos_local_wallet_path','assets_not_end_to_end_verified','ok','worker_unavailable') THEN RAISE EXCEPTION 'invalid_outcome'; END IF;
 IF p_checks ? 'hqPolicyFingerprint' AND (coalesce(p_checks->>'hqPolicyFingerprint','') !~ '^[a-f0-9]{64}$' OR p_checks->>'hqPolicyScope' IS DISTINCT FROM 'youzan_chain_hq') THEN RAISE EXCEPTION 'invalid_hq_policy_evidence'; END IF;
 safe_checks=jsonb_build_object('ownership',coalesce((p_checks->>'ownership')::boolean,false),
 'tokensReadBack',coalesce((p_checks->>'tokensReadBack')::boolean,false),
 'rulesSupported',coalesce((p_checks->>'rulesSupported')::boolean,false),
 'rulesEquivalent',coalesce((p_checks->>'rulesEquivalent')::boolean,false),
 'posSafe',coalesce((p_checks->>'posSafe')::boolean,false),
 'assetsEndToEnd',coalesce((p_checks->>'assetsEndToEnd')::boolean,false),
 'eligible',greatest(0,coalesce((p_checks->>'eligible')::integer,0)),
 'mapped',greatest(0,coalesce((p_checks->>'mapped')::integer,0)),
 'currentProjectionFailures',greatest(0,coalesce((p_checks->>'currentProjectionFailures')::integer,0)));
 IF p_status<>'blocked' AND (NOT (safe_checks->>'ownership')::boolean OR NOT (safe_checks->>'tokensReadBack')::boolean
 OR NOT (safe_checks->>'rulesSupported')::boolean OR NOT (safe_checks->>'rulesEquivalent')::boolean
 OR NOT (safe_checks->>'posSafe')::boolean OR (safe_checks->>'eligible')::integer<=0
 OR (safe_checks->>'mapped')::integer<>(safe_checks->>'eligible')::integer
 OR (safe_checks->>'currentProjectionFailures')::integer>0
 OR EXISTS(SELECT 1 FROM public.commerce_membership_plans WHERE points_redemption_enabled)
 OR (p_status='verified' AND NOT (safe_checks->>'assetsEndToEnd')::boolean)
 OR (p_status='configuration_verified' AND p_reason<>'assets_not_end_to_end_verified')) THEN RAISE EXCEPTION 'evidence_required'; END IF;
 IF p_checks ? 'hqPolicyFingerprint' THEN
   IF p_status<>'blocked' AND NOT coalesce((p_checks->>'youzanPosInheritanceVerified')::boolean,false) THEN RAISE EXCEPTION 'native_pos_inheritance_unverified'; END IF;
   safe_checks=safe_checks || jsonb_build_object('hqPolicyFingerprint',p_checks->>'hqPolicyFingerprint','hqPolicyScope','youzan_chain_hq','hqPolicyKdtId',(p_checks->>'hqPolicyKdtId')::bigint,'hqConfigurationMirrorVerified',coalesce((p_checks->>'hqConfigurationMirrorVerified')::boolean,false),'youzanPosInheritanceVerified',coalesce((p_checks->>'youzanPosInheritanceVerified')::boolean,false));
 END IF;
 -- Match the shop-trigger lock order; changes fence old receipts.
 PERFORM 1 FROM public.youzan_shops WHERE id=p_shop_id AND role='branch' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO j FROM public.member_onboarding_jobs WHERE shop_id=p_shop_id FOR UPDATE;
 IF NOT FOUND OR j.status<>'running' OR j.revision<>p_revision OR j.claim_token IS DISTINCT FROM p_token OR j.lease_until<=now()
 OR NOT EXISTS(SELECT 1 FROM public.youzan_shops WHERE id=p_shop_id AND kdt_id=j.kdt_id
 AND parent_kdt_id IS NOT DISTINCT FROM j.parent_kdt_id) THEN RETURN false; END IF;
 IF p_checks ? 'hqPolicyFingerprint' AND (p_checks->>'hqPolicyKdtId')::bigint IS DISTINCT FROM j.parent_kdt_id THEN RAISE EXCEPTION 'hq_policy_scope_mismatch'; END IF;
 SELECT count(*),(array_agg(id ORDER BY id))[1] INTO loc_count,loc FROM public.inv_locations WHERE shop_id=p_shop_id AND is_active;
 notice_key=p_status||':'||p_reason;
 IF loc_count=1 AND j.last_notice_key IS DISTINCT FROM notice_key THEN
 INSERT INTO public.inv_handheld_notifications(location_id,kind,title,payload,audience,action_status,ref_type,ref_id)
 VALUES(loc,'system',CASE WHEN p_status='blocked' THEN '门店会员接入遇到阻碍'
 WHEN p_status='configuration_verified' THEN '门店会员配置检查通过，资产尚未完整验收' ELSE '门店会员接入验收通过' END,
 jsonb_build_object('kind','member_onboarding','shop_id',p_shop_id,'status',p_status,'reason',p_reason,
 'assets_end_to_end',p_status='verified'),'location',CASE WHEN p_status='blocked' THEN 'pending' ELSE 'handled' END,'member_onboarding',p_shop_id);
 END IF;
 UPDATE public.member_onboarding_jobs SET status=p_status,reason=p_reason,checks=safe_checks,claim_token=NULL,lease_until=NULL,
 last_notice_key=CASE WHEN loc_count=1 THEN notice_key ELSE last_notice_key END,updated_at=now() WHERE shop_id=p_shop_id;
 RETURN true;
END $$;
