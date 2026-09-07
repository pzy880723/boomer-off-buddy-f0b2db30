-- ============================================================
-- BOOMER 门店经营目标（日目标为主）+ 线下补录 + GO 身份桥接登记
-- 全部为新增对象，不修改既有表。
-- ============================================================

-- 1. 月目标方案（仅作为日目标拆解依据）
CREATE TABLE public.store_monthly_target_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  period_month date NOT NULL,
  target_amount_fen bigint NOT NULL CHECK (target_amount_fen >= 0),
  weekday_weights jsonb NOT NULL DEFAULT '{"1":1,"2":1,"3":1,"4":1,"5":1,"6":1.5,"7":1.5}'::jsonb,
  date_weight_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  closed_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_at timestamptz,
  note text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_monthly_target_plans_month_is_first_day CHECK (date_trunc('month', period_month)::date = period_month),
  CONSTRAINT store_monthly_target_plans_version_uniq UNIQUE (location_id, period_month, version)
);

CREATE UNIQUE INDEX store_monthly_target_plans_one_published
  ON public.store_monthly_target_plans (location_id, period_month)
  WHERE status = 'published';

CREATE INDEX store_monthly_target_plans_location_month_idx
  ON public.store_monthly_target_plans (location_id, period_month DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_monthly_target_plans TO authenticated;
GRANT ALL ON public.store_monthly_target_plans TO service_role;
ALTER TABLE public.store_monthly_target_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hq manage monthly target plans"
  ON public.store_monthly_target_plans FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

CREATE POLICY "store staff read own monthly target plans"
  ON public.store_monthly_target_plans FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.user_location_perms p
      WHERE p.user_id = auth.uid() AND p.location_id = store_monthly_target_plans.location_id
    )
  );

-- 2. 每日目标（首页真源）
CREATE TABLE public.store_daily_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  target_date date NOT NULL,
  target_amount_fen bigint NOT NULL CHECK (target_amount_fen >= 0),
  plan_id uuid REFERENCES public.store_monthly_target_plans(id) ON DELETE SET NULL,
  plan_version integer,
  weight numeric,
  source text NOT NULL DEFAULT 'allocated' CHECK (source IN ('allocated','manual_override','closed_day')),
  is_locked boolean NOT NULL DEFAULT false,
  note text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_daily_targets_location_date_uniq UNIQUE (location_id, target_date)
);

CREATE INDEX store_daily_targets_date_idx ON public.store_daily_targets (target_date, location_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_daily_targets TO authenticated;
GRANT ALL ON public.store_daily_targets TO service_role;
ALTER TABLE public.store_daily_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hq manage daily targets"
  ON public.store_daily_targets FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

CREATE POLICY "store staff read own daily targets"
  ON public.store_daily_targets FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_location_perms p
      WHERE p.user_id = auth.uid() AND p.location_id = store_daily_targets.location_id
    )
  );

-- 3. 目标审计
CREATE TABLE public.store_target_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('monthly_plan','daily_target')),
  entity_id uuid,
  location_id uuid,
  period_month date,
  target_date date,
  action text NOT NULL CHECK (action IN ('create','update','publish','archive','daily_override','recalculate')),
  before_snapshot jsonb,
  after_snapshot jsonb,
  reason text,
  actor_id uuid,
  actor_role text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX store_target_audit_logs_entity_idx ON public.store_target_audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX store_target_audit_logs_location_idx ON public.store_target_audit_logs (location_id, created_at DESC);

GRANT SELECT ON public.store_target_audit_logs TO authenticated;
GRANT ALL ON public.store_target_audit_logs TO service_role;
ALTER TABLE public.store_target_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hq read target audit"
  ON public.store_target_audit_logs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

-- 4. 线下补录账本（仅未进入有赞的收款）
CREATE TABLE public.store_offline_sales_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  channel text NOT NULL CHECK (channel IN ('cash','pos_card','wechat_qr','alipay_qr','bank_transfer','other')),
  amount_fen bigint NOT NULL CHECK (amount_fen <> 0),
  order_count integer NOT NULL DEFAULT 1 CHECK (order_count >= 0),
  evidence_type text NOT NULL CHECK (evidence_type IN ('pos_receipt','payment_screenshot','bank_slip','handwritten_slip','manual_declaration')),
  evidence_ref text,
  evidence_url text,
  youzan_exclusion_basis text NOT NULL DEFAULT 'unverified'
    CHECK (youzan_exclusion_basis IN ('device_not_youzan','operator_declared','reconciled_against_youzan','unverified')),
  youzan_excluded_tids text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz,
  note text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  client_op_id text NOT NULL,
  created_by uuid,
  updated_by uuid,
  voided_by uuid,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_offline_sales_entries_client_op_uniq UNIQUE (location_id, client_op_id)
);

CREATE INDEX store_offline_sales_entries_location_date_idx
  ON public.store_offline_sales_entries (location_id, business_date DESC, status);

GRANT SELECT, INSERT, UPDATE ON public.store_offline_sales_entries TO authenticated;
GRANT ALL ON public.store_offline_sales_entries TO service_role;
ALTER TABLE public.store_offline_sales_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hq manage offline sales"
  ON public.store_offline_sales_entries FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

CREATE POLICY "store staff read own offline sales"
  ON public.store_offline_sales_entries FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_location_perms p
      WHERE p.user_id = auth.uid() AND p.location_id = store_offline_sales_entries.location_id
    )
  );

CREATE POLICY "store staff insert own offline sales"
  ON public.store_offline_sales_entries FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND status = 'active'
    AND EXISTS (
      SELECT 1 FROM public.user_location_perms p
      WHERE p.user_id = auth.uid() AND p.location_id = store_offline_sales_entries.location_id
    )
  );

CREATE TABLE public.store_offline_sales_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid REFERENCES public.store_offline_sales_entries(id) ON DELETE SET NULL,
  location_id uuid,
  business_date date,
  action text NOT NULL CHECK (action IN ('create','update','void','replay_idempotent')),
  before_snapshot jsonb,
  after_snapshot jsonb,
  reason text,
  actor_id uuid,
  actor_role text,
  client_op_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX store_offline_sales_audit_logs_entry_idx
  ON public.store_offline_sales_audit_logs (entry_id, created_at DESC);

GRANT SELECT ON public.store_offline_sales_audit_logs TO authenticated;
GRANT ALL ON public.store_offline_sales_audit_logs TO service_role;
ALTER TABLE public.store_offline_sales_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hq read offline sales audit"
  ON public.store_offline_sales_audit_logs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

-- 5. GO 外部身份桥接登记（默认待审核，审核前不授予任何访问权）
CREATE TABLE public.go_identity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  go_project_ref text NOT NULL,
  go_user_id text NOT NULL,
  go_phone_hash text,
  erp_user_id uuid,
  location_id uuid REFERENCES public.inv_locations(id) ON DELETE SET NULL,
  erp_role text CHECK (erp_role IN ('store_staff','store_manager','hq_operator')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','revoked')),
  approved_by uuid,
  approved_at timestamptz,
  revoked_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT go_identity_links_project_user_uniq UNIQUE (go_project_ref, go_user_id)
);

GRANT SELECT, INSERT, UPDATE ON public.go_identity_links TO authenticated;
GRANT ALL ON public.go_identity_links TO service_role;
ALTER TABLE public.go_identity_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hq manage go identity links"
  ON public.go_identity_links FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

-- 6. updated_at 触发器（复用既有 tg_set_updated_at）
CREATE TRIGGER store_monthly_target_plans_set_updated_at
  BEFORE UPDATE ON public.store_monthly_target_plans
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TRIGGER store_daily_targets_set_updated_at
  BEFORE UPDATE ON public.store_daily_targets
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TRIGGER store_offline_sales_entries_set_updated_at
  BEFORE UPDATE ON public.store_offline_sales_entries
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

CREATE TRIGGER go_identity_links_set_updated_at
  BEFORE UPDATE ON public.go_identity_links
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();