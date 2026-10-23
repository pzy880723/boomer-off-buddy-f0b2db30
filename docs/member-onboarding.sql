CREATE TABLE public.member_onboarding_jobs (
 shop_id uuid PRIMARY KEY REFERENCES public.youzan_shops(id), kdt_id bigint NOT NULL, parent_kdt_id bigint,
 revision integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','blocked','configuration_verified','verified')),
 reason text, checks jsonb NOT NULL DEFAULT '{}', claim_token uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0, last_notice_key text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.member_onboarding_jobs TO service_role;
ALTER TABLE public.member_onboarding_jobs ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.member_onboarding_enqueue(p_shop_id uuid,p_force boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s public.youzan_shops%ROWTYPE;
BEGIN
 SELECT * INTO s FROM public.youzan_shops WHERE id=p_shop_id;
 IF NOT FOUND OR s.role<>'branch' OR s.status<>'active' OR s.kdt_id<=0 THEN RETURN; END IF;
 INSERT INTO public.member_onboarding_jobs(shop_id,kdt_id,parent_kdt_id) VALUES(s.id,s.kdt_id,s.parent_kdt_id)
 ON CONFLICT(shop_id) DO UPDATE SET kdt_id=EXCLUDED.kdt_id,parent_kdt_id=EXCLUDED.parent_kdt_id,
 revision=member_onboarding_jobs.revision+1,status='queued',reason=NULL,checks='{}',
 claim_token=NULL,lease_until=NULL,attempts=0,updated_at=now()
 WHERE p_force OR member_onboarding_jobs.kdt_id IS DISTINCT FROM EXCLUDED.kdt_id
 OR member_onboarding_jobs.parent_kdt_id IS DISTINCT FROM EXCLUDED.parent_kdt_id;
 IF FOUND THEN PERFORM pg_notify('member_onboarding',s.id::text); END IF;
END $$;

CREATE FUNCTION public.member_onboarding_shop_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE b record; old_head bigint;
BEGIN
 IF TG_OP='UPDATE' THEN
   old_head=CASE WHEN OLD.role='hq' THEN OLD.kdt_id ELSE NULL END;
   IF NEW.kdt_id IS NOT DISTINCT FROM OLD.kdt_id AND NEW.parent_kdt_id IS NOT DISTINCT FROM OLD.parent_kdt_id
   AND NEW.role IS NOT DISTINCT FROM OLD.role AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 END IF;
 IF NEW.role='branch' AND NEW.status='active' THEN PERFORM public.member_onboarding_enqueue(NEW.id,TG_OP='UPDATE');
 ELSIF TG_OP='UPDATE' THEN UPDATE public.member_onboarding_jobs SET revision=revision+1,status='blocked',reason='shop_inactive',
 claim_token=NULL,lease_until=NULL,checks='{}',updated_at=now() WHERE shop_id=NEW.id; END IF;
 IF NEW.role='hq' OR old_head IS NOT NULL THEN
   FOR b IN SELECT id FROM public.youzan_shops WHERE role='branch' AND status='active'
   AND (parent_kdt_id=NEW.kdt_id OR parent_kdt_id=old_head) LOOP PERFORM public.member_onboarding_enqueue(b.id,true); END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trg_member_onboarding_shop_changed AFTER INSERT OR UPDATE OF kdt_id,parent_kdt_id,role,status
ON public.youzan_shops FOR EACH ROW EXECUTE FUNCTION public.member_onboarding_shop_changed();

CREATE FUNCTION public.member_onboarding_claim(p_shop_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j public.member_onboarding_jobs%ROWTYPE;
BEGIN
 SELECT q.* INTO j FROM public.member_onboarding_jobs q JOIN public.youzan_shops s ON s.id=q.shop_id
 WHERE q.shop_id=p_shop_id AND s.role='branch' AND s.status='active' AND s.kdt_id=q.kdt_id
 AND s.parent_kdt_id IS NOT DISTINCT FROM q.parent_kdt_id
 AND (q.status='queued' OR (q.status='running' AND q.lease_until<now())) FOR UPDATE OF q SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE public.member_onboarding_jobs SET status='running',claim_token=gen_random_uuid(),
 lease_until=now()+interval '10 minutes',attempts=attempts+1,updated_at=now() WHERE shop_id=p_shop_id RETURNING * INTO j;
 RETURN jsonb_build_object('shop_id',j.shop_id,'kdt_id',j.kdt_id,'parent_kdt_id',j.parent_kdt_id,
 'revision',j.revision,'claim_token',j.claim_token,'lease_until',j.lease_until);
END $$;

CREATE FUNCTION public.member_onboarding_finish(p_shop_id uuid,p_revision integer,p_token uuid,p_status text,p_reason text,p_checks jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j public.member_onboarding_jobs%ROWTYPE; loc uuid; loc_count integer; notice_key text; safe_checks jsonb;
BEGIN
 IF p_status NOT IN ('blocked','configuration_verified','verified') OR p_reason NOT IN
 ('hq_ownership_unverified','token_unavailable','member_mapping_incomplete','rule_semantics_unverified','pos_local_wallet_path','assets_not_end_to_end_verified','ok','worker_unavailable') THEN RAISE EXCEPTION 'invalid_outcome'; END IF;
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
 -- Match the shop-trigger lock order; changes fence old receipts.
 PERFORM 1 FROM public.youzan_shops WHERE id=p_shop_id AND role='branch' AND status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO j FROM public.member_onboarding_jobs WHERE shop_id=p_shop_id FOR UPDATE;
 IF NOT FOUND OR j.status<>'running' OR j.revision<>p_revision OR j.claim_token IS DISTINCT FROM p_token OR j.lease_until<=now()
 OR NOT EXISTS(SELECT 1 FROM public.youzan_shops WHERE id=p_shop_id AND kdt_id=j.kdt_id
 AND parent_kdt_id IS NOT DISTINCT FROM j.parent_kdt_id) THEN RETURN false; END IF;
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
REVOKE ALL ON FUNCTION public.member_onboarding_enqueue(uuid,boolean),public.member_onboarding_shop_changed(),public.member_onboarding_claim(uuid),public.member_onboarding_finish(uuid,integer,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_onboarding_enqueue(uuid,boolean),public.member_onboarding_claim(uuid),public.member_onboarding_finish(uuid,integer,uuid,text,text,jsonb) TO service_role;
-- One-time additive bootstrap of branch snapshots only; no asset writes.
INSERT INTO public.member_onboarding_jobs(shop_id,kdt_id,parent_kdt_id)
SELECT id,kdt_id,parent_kdt_id FROM public.youzan_shops WHERE role='branch' AND status='active' AND kdt_id>0 ON CONFLICT(shop_id) DO NOTHING;