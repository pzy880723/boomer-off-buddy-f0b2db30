ALTER TABLE public.commerce_newcomer_grants ADD COLUMN IF NOT EXISTS subject_snapshot text;
UPDATE public.commerce_newcomer_grants g SET subject_snapshot = c.external_subject
  FROM public.commerce_customers c WHERE c.id = g.customer_id AND g.subject_snapshot IS NULL;

CREATE OR REPLACE FUNCTION public.commerce_newcomer_grant_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.subject_snapshot IS NULL THEN
    SELECT external_subject INTO NEW.subject_snapshot FROM commerce_customers WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commerce_newcomer_grant_snapshot ON public.commerce_newcomer_grants;
CREATE TRIGGER commerce_newcomer_grant_snapshot BEFORE INSERT ON public.commerce_newcomer_grants
  FOR EACH ROW EXECUTE FUNCTION public.commerce_newcomer_grant_snapshot();

CREATE OR REPLACE FUNCTION public.commerce_newcomer_identity_check(p_slot uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE s commerce_newcomer_grant_slots; g commerce_newcomer_grants; c commerce_customers; v_digits text; v_n integer;
BEGIN
  SELECT * INTO s FROM commerce_newcomer_grant_slots WHERE id = p_slot;
  IF NOT FOUND OR s.claim_token IS DISTINCT FROM p_token THEN RETURN jsonb_build_object('status','stale'); END IF;
  SELECT * INTO g FROM commerce_newcomer_grants WHERE id = s.grant_id;
  SELECT * INTO c FROM commerce_customers WHERE id = g.customer_id;
  IF NOT FOUND OR c.status <> 'active' THEN RETURN jsonb_build_object('status','blocked','reason','customer_inactive'); END IF;
  IF COALESCE(btrim(c.external_subject),'') = '' OR g.subject_snapshot IS NULL OR c.external_subject <> g.subject_snapshot THEN
    RETURN jsonb_build_object('status','blocked','reason','external_subject_changed');
  END IF;
  v_digits := regexp_replace(COALESCE(c.phone,''), '\D', '', 'g');
  IF v_digits !~ '^1[3-9]\d{9}$' OR encode(sha256(convert_to(v_digits,'UTF8')),'hex') <> g.phone_key THEN
    RETURN jsonb_build_object('status','blocked','reason','phone_changed');
  END IF;
  SELECT count(*) INTO v_n FROM commerce_customer_identities i
   WHERE i.customer_id = c.id AND i.provider = 'phone';
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM commerce_customer_identities i WHERE i.customer_id = c.id AND i.provider = 'phone'
       AND regexp_replace(i.provider_subject,'\D','','g') = v_digits) THEN
    RETURN jsonb_build_object('status','blocked','reason','phone_identity_mismatch');
  END IF;
  IF EXISTS (SELECT 1 FROM commerce_customer_identities i WHERE i.customer_id <> c.id AND i.provider = 'phone'
       AND regexp_replace(i.provider_subject,'\D','','g') = v_digits)
     OR EXISTS (SELECT 1 FROM commerce_customers o WHERE o.id <> c.id AND o.status = 'active'
       AND regexp_replace(COALESCE(o.phone,''),'\D','','g') = v_digits) THEN
    RETURN jsonb_build_object('status','blocked','reason','phone_identity_conflict');
  END IF;
  RETURN jsonb_build_object('status','ok','customer_id',c.id);
END $$;

REVOKE ALL ON FUNCTION public.commerce_newcomer_identity_check(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_newcomer_identity_check(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.commerce_newcomer_grant_snapshot() FROM PUBLIC, anon, authenticated;