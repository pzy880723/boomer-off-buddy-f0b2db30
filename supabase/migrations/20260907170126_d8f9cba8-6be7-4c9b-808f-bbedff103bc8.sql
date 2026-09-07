-- GO 门店 -> ERP 门店 可信映射（无记录即不可越权）
CREATE TABLE public.go_shop_location_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  go_project_ref text NOT NULL,
  go_shop_id text NOT NULL,
  location_id uuid NOT NULL REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  note text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT go_shop_location_links_project_shop_uniq UNIQUE (go_project_ref, go_shop_id)
);

GRANT SELECT ON public.go_shop_location_links TO authenticated;
GRANT ALL ON public.go_shop_location_links TO service_role;
ALTER TABLE public.go_shop_location_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hq manage go shop links"
  ON public.go_shop_location_links FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

CREATE TRIGGER go_shop_location_links_set_updated_at
  BEFORE UPDATE ON public.go_shop_location_links
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- 角色 / 门店范围变更审计
CREATE TABLE public.user_scope_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN (
    'grant_role','revoke_role','grant_location','revoke_location',
    'approve_go_identity','revoke_go_identity','link_go_shop','unlink_go_shop'
  )),
  role text,
  location_id uuid,
  before_snapshot jsonb,
  after_snapshot jsonb,
  reason text,
  actor_id uuid,
  actor_role text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_scope_audit_logs_target_idx
  ON public.user_scope_audit_logs (target_user_id, created_at DESC);

GRANT SELECT ON public.user_scope_audit_logs TO authenticated;
GRANT ALL ON public.user_scope_audit_logs TO service_role;
ALTER TABLE public.user_scope_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hq read user scope audit"
  ON public.user_scope_audit_logs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

-- 一个 ERP 账号最多一条 approved GO 身份
CREATE UNIQUE INDEX go_identity_links_erp_user_approved_uniq
  ON public.go_identity_links (erp_user_id)
  WHERE status = 'approved' AND erp_user_id IS NOT NULL;