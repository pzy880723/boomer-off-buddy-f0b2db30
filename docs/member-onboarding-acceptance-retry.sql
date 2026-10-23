ALTER TABLE public.member_onboarding_jobs ADD COLUMN retry_after timestamptz;
COMMENT ON COLUMN public.member_onboarding_jobs.retry_after IS 'Service-only transient retry due time; attempts and revision are never reset by retry.';
CREATE INDEX member_onboarding_retry_due_idx ON public.member_onboarding_jobs(retry_after) WHERE status='blocked' AND reason='worker_unavailable';
CREATE OR REPLACE FUNCTION public.member_onboarding_enqueue(p_shop_id uuid,p_force boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s public.youzan_shops%ROWTYPE;
BEGIN
 SELECT * INTO s FROM public.youzan_shops WHERE id=p_shop_id;
 IF NOT FOUND OR s.role<>'branch' OR s.status<>'active' OR s.kdt_id<=0 THEN RETURN; END IF;
 INSERT INTO public.member_onboarding_jobs(shop_id,kdt_id,parent_kdt_id) VALUES(s.id,s.kdt_id,s.parent_kdt_id)
 ON CONFLICT(shop_id) DO UPDATE SET kdt_id=EXCLUDED.kdt_id,parent_kdt_id=EXCLUDED.parent_kdt_id,
 revision=member_onboarding_jobs.revision+1,status='queued',reason=NULL,checks='{}',
 claim_token=NULL,lease_until=NULL,retry_after=NULL,attempts=0,updated_at=now()
 WHERE p_force OR member_onboarding_jobs.kdt_id IS DISTINCT FROM EXCLUDED.kdt_id
 OR member_onboarding_jobs.parent_kdt_id IS DISTINCT FROM EXCLUDED.parent_kdt_id;
 IF FOUND THEN PERFORM pg_notify('member_onboarding',s.id::text); END IF;
END $$;

CREATE OR REPLACE FUNCTION public.member_onboarding_claim(p_shop_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j public.member_onboarding_jobs%ROWTYPE;
BEGIN
 SELECT q.* INTO j FROM public.member_onboarding_jobs q JOIN public.youzan_shops s ON s.id=q.shop_id
 WHERE q.shop_id=p_shop_id AND s.role='branch' AND s.status='active' AND s.kdt_id=q.kdt_id
 AND s.parent_kdt_id IS NOT DISTINCT FROM q.parent_kdt_id
 AND (q.status='queued' OR (q.status='running' AND q.lease_until<now())
 OR (q.status='blocked' AND q.reason='worker_unavailable' AND q.attempts<3
 AND q.checks->'transientRetryEligible'='true'::jsonb AND q.retry_after<=now())) FOR UPDATE OF q SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE public.member_onboarding_jobs SET status='running',retry_after=NULL,claim_token=gen_random_uuid(),
 lease_until=now()+interval '10 minutes',attempts=attempts+1,updated_at=now() WHERE shop_id=p_shop_id RETURNING * INTO j;
 RETURN jsonb_build_object('shop_id',j.shop_id,'kdt_id',j.kdt_id,'parent_kdt_id',j.parent_kdt_id,
 'revision',j.revision,'claim_token',j.claim_token,'lease_until',j.lease_until);
END $$;

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
 'youzanPosInheritanceVerified',coalesce((p_checks->>'youzanPosInheritanceVerified')::boolean,false),
 'transientRetryEligible',p_checks->'transientRetryEligible'='true'::jsonb,
 'currentProjectionFailures',greatest(0,coalesce((p_checks->>'currentProjectionFailures')::integer,0)));
 IF p_status<>'blocked' AND (NOT (safe_checks->>'ownership')::boolean OR NOT (safe_checks->>'tokensReadBack')::boolean
 OR NOT (safe_checks->>'rulesSupported')::boolean OR NOT (safe_checks->>'rulesEquivalent')::boolean
 OR NOT (safe_checks->>'posSafe')::boolean OR (safe_checks->>'eligible')::integer<=0
 OR (safe_checks->>'mapped')::integer<>(safe_checks->>'eligible')::integer
 OR (safe_checks->>'currentProjectionFailures')::integer>0
 OR EXISTS(SELECT 1 FROM public.commerce_membership_plans WHERE points_redemption_enabled)
 OR (p_status='verified' AND NOT (safe_checks->>'assetsEndToEnd')::boolean)
 OR (p_status='configuration_verified' AND p_reason<>'assets_not_end_to_end_verified')) THEN RAISE EXCEPTION 'evidence_required'; END IF;
 IF p_status<>'blocked' AND (p_checks->>'hqPolicyScope' IS DISTINCT FROM 'youzan_chain_hq'
 OR coalesce(p_checks->>'hqPolicyFingerprint','') !~ '^[a-f0-9]{64}$'
 OR coalesce(p_checks->>'hqPolicyKdtId','') !~ '^[1-9][0-9]*$'
 OR p_checks->'hqConfigurationMirrorVerified' IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'hq_policy_evidence_required'; END IF;
 IF p_status<>'blocked' AND p_checks->'youzanPosInheritanceVerified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'native_pos_inheritance_unverified'; END IF;
 IF p_checks ? 'hqPolicyFingerprint' THEN
   safe_checks=safe_checks || jsonb_build_object('hqPolicyFingerprint',p_checks->>'hqPolicyFingerprint','hqPolicyScope','youzan_chain_hq','hqPolicyKdtId',(p_checks->>'hqPolicyKdtId')::bigint,'hqConfigurationMirrorVerified',coalesce((p_checks->>'hqConfigurationMirrorVerified')::boolean,false),'youzanPosInheritanceVerified',coalesce((p_checks->>'youzanPosInheritanceVerified')::boolean,false));
 END IF;
 -- Match the shop-trigger lock order; changes fence old receipts.
 PERFORM 1 FROM public.youzan_shops WHERE id=p_shop_id AND role='branch' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO j FROM public.member_onboarding_jobs WHERE shop_id=p_shop_id FOR UPDATE;
 IF NOT FOUND OR j.status<>'running' OR j.revision<>p_revision OR j.claim_token IS DISTINCT FROM p_token OR (j.lease_until IS NULL OR j.lease_until<=now())
 OR NOT EXISTS(SELECT 1 FROM public.youzan_shops WHERE id=p_shop_id AND kdt_id=j.kdt_id
 AND parent_kdt_id IS NOT DISTINCT FROM j.parent_kdt_id) THEN RETURN false; END IF;
 IF (p_status<>'blocked' OR p_checks ? 'hqPolicyFingerprint') AND (p_checks->>'hqPolicyKdtId')::bigint IS DISTINCT FROM j.parent_kdt_id THEN RAISE EXCEPTION 'hq_policy_scope_mismatch'; END IF;
 -- Delayed retries remain blocked diagnostics; never reset attempts/revision or notify a retry wake.
 IF p_status='blocked' AND p_reason='worker_unavailable'
 AND p_checks->'transientRetryEligible'='true'::jsonb AND j.attempts<3 THEN
   UPDATE public.member_onboarding_jobs SET status='blocked',reason=p_reason,checks=safe_checks,
   claim_token=NULL,lease_until=NULL,retry_after=now()+interval '15 minutes',updated_at=now() WHERE shop_id=p_shop_id;
   RETURN true;
 END IF;
 SELECT count(*),(array_agg(id ORDER BY id))[1] INTO loc_count,loc FROM public.inv_locations WHERE shop_id=p_shop_id AND is_active;
 notice_key=p_status||':'||p_reason;
 IF loc_count=1 AND j.last_notice_key IS DISTINCT FROM notice_key THEN
 INSERT INTO public.inv_handheld_notifications(location_id,kind,title,payload,audience,action_status,ref_type,ref_id)
 VALUES(loc,'system',CASE WHEN p_status='blocked' THEN '门店会员接入遇到阻碍'
 WHEN p_status='configuration_verified' THEN '门店会员配置检查通过，资产尚未完整验收' ELSE '门店会员接入验收通过' END,
 jsonb_build_object('kind','member_onboarding','shop_id',p_shop_id,'status',p_status,'reason',p_reason,
 'assets_end_to_end',p_status='verified'),'location',CASE WHEN p_status='blocked' THEN 'pending' ELSE 'handled' END,'member_onboarding',p_shop_id);
 END IF;
 UPDATE public.member_onboarding_jobs SET status=p_status,reason=p_reason,checks=safe_checks,claim_token=NULL,lease_until=NULL,retry_after=NULL,
 last_notice_key=CASE WHEN loc_count=1 THEN notice_key ELSE last_notice_key END,updated_at=now() WHERE shop_id=p_shop_id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.member_onboarding_enqueue(uuid,boolean),public.member_onboarding_claim(uuid),public.member_onboarding_finish(uuid,integer,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_onboarding_enqueue(uuid,boolean),public.member_onboarding_claim(uuid),public.member_onboarding_finish(uuid,integer,uuid,text,text,jsonb) TO service_role;
