-- BOOMER OPEN store-development domain.
-- This schema is designed to run on both Lovable Supabase and the future
-- self-hosted Supabase-compatible stack on Tencent Cloud.

CREATE TABLE IF NOT EXISTS public.store_development_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text UNIQUE,
  name text NOT NULL,
  brand text NOT NULL DEFAULT 'BOOMER OFF',
  project_kind text NOT NULL DEFAULT 'formal'
    CHECK (project_kind IN ('candidate', 'formal')),
  status text NOT NULL DEFAULT 'planning'
    CHECK (status IN (
      'candidate',
      'planning',
      'site_selection',
      'contracting',
      'construction',
      'pre_opening',
      'acceptance',
      'opened',
      'archived',
      'cancelled'
    )),
  address text,
  place_name text,
  latitude numeric(10, 7),
  longitude numeric(10, 7),
  progress numeric(6, 5) NOT NULL DEFAULT 0
    CHECK (progress >= 0 AND progress <= 1),
  budget_amount numeric(14, 2) NOT NULL DEFAULT 0
    CHECK (budget_amount >= 0),
  deposit_target_amount numeric(14, 2) NOT NULL DEFAULT 0
    CHECK (deposit_target_amount >= 0),
  handover_date date,
  planned_opening_date date,
  opened_at timestamptz,
  location_id uuid REFERENCES public.inv_locations(id) ON DELETE SET NULL,
  source_system text NOT NULL DEFAULT 'erp',
  source_updated_at timestamptz,
  legacy_document jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (
    (status = 'opened' AND project_kind = 'formal')
    OR status <> 'opened'
  )
);

CREATE INDEX IF NOT EXISTS store_development_projects_status_idx
  ON public.store_development_projects(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS store_development_projects_location_idx
  ON public.store_development_projects(location_id)
  WHERE location_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.store_development_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL
    REFERENCES public.store_development_projects(id) ON DELETE CASCADE,
  stage_key text NOT NULL,
  title text NOT NULL,
  subtitle text,
  status text NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming', 'active', 'completed', 'skipped')),
  sort_order integer NOT NULL DEFAULT 0,
  planned_start_date date,
  planned_end_date date,
  actual_completed_at timestamptz,
  legacy_document jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, stage_key),
  UNIQUE(project_id, sort_order)
);

CREATE INDEX IF NOT EXISTS store_development_stages_project_idx
  ON public.store_development_stages(project_id, sort_order);

CREATE TABLE IF NOT EXISTS public.store_development_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id uuid NOT NULL
    REFERENCES public.store_development_stages(id) ON DELETE CASCADE,
  task_key text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  sort_order integer NOT NULL DEFAULT 0,
  assignee_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_at timestamptz,
  completed_at timestamptz,
  legacy_document jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stage_id, task_key),
  UNIQUE(stage_id, sort_order)
);

CREATE INDEX IF NOT EXISTS store_development_tasks_stage_idx
  ON public.store_development_tasks(stage_id, sort_order);

CREATE TABLE IF NOT EXISTS public.store_development_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text UNIQUE,
  project_id uuid NOT NULL
    REFERENCES public.store_development_projects(id) ON DELETE CASCADE,
  stage_id uuid
    REFERENCES public.store_development_stages(id) ON DELETE SET NULL,
  kind text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  storage_provider text NOT NULL DEFAULT 'tencent_cos'
    CHECK (storage_provider IN ('tencent_cos', 'supabase_storage')),
  storage_bucket text NOT NULL,
  storage_region text,
  storage_path text NOT NULL,
  checksum_sha256 text,
  source_created_at timestamptz,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(storage_provider, storage_bucket, storage_path)
);

CREATE INDEX IF NOT EXISTS store_development_attachments_project_idx
  ON public.store_development_attachments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS store_development_attachments_stage_idx
  ON public.store_development_attachments(stage_id, created_at DESC)
  WHERE stage_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.store_development_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text UNIQUE,
  project_id uuid NOT NULL
    REFERENCES public.store_development_projects(id) ON DELETE CASCADE,
  stage_id uuid
    REFERENCES public.store_development_stages(id) ON DELETE SET NULL,
  item_name text NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  deposit_amount numeric(14, 2) NOT NULL DEFAULT 0
    CHECK (deposit_amount >= 0 AND deposit_amount <= amount),
  category text NOT NULL,
  vendor text,
  invoice_status text NOT NULL DEFAULT 'unknown',
  recognition_id text,
  source_attachment_id uuid
    REFERENCES public.store_development_attachments(id) ON DELETE SET NULL,
  source_created_at timestamptz,
  legacy_document jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_development_costs_project_idx
  ON public.store_development_costs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS store_development_costs_stage_idx
  ON public.store_development_costs(stage_id)
  WHERE stage_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.store_development_contract_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text UNIQUE,
  project_id uuid NOT NULL
    REFERENCES public.store_development_projects(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL UNIQUE
    REFERENCES public.store_development_attachments(id) ON DELETE CASCADE,
  status text NOT NULL
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  deposit_amount numeric(14, 2),
  deposit_refund_terms text,
  deposit_refund_deadline text,
  contract_start_date date,
  contract_end_date date,
  monthly_rent numeric(14, 2),
  rent_payment_terms text,
  key_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text,
  error_message text,
  raw_document jsonb NOT NULL DEFAULT '{}'::jsonb,
  analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_development_contract_project_idx
  ON public.store_development_contract_analyses(project_id, analyzed_at DESC);

CREATE TABLE IF NOT EXISTS public.store_development_ai_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text UNIQUE,
  project_id uuid NOT NULL
    REFERENCES public.store_development_projects(id) ON DELETE CASCADE,
  attachment_id uuid
    REFERENCES public.store_development_attachments(id) ON DELETE SET NULL,
  operation text NOT NULL,
  provider text,
  model text,
  status text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  result_document jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_development_ai_logs_project_idx
  ON public.store_development_ai_logs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.store_development_audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  actor_id uuid,
  source text NOT NULL DEFAULT 'database',
  old_snapshot jsonb,
  new_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_development_audit_entity_idx
  ON public.store_development_audit_logs(entity_type, entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.can_manage_store_development(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_role(_user_id, 'super_admin')
    OR public.has_role(_user_id, 'hq_operator')
$$;

REVOKE EXECUTE ON FUNCTION public.can_manage_store_development(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_store_development(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.audit_store_development_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entity_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_entity_id := OLD.id;
  ELSE
    v_entity_id := NEW.id;
  END IF;
  INSERT INTO public.store_development_audit_logs (
    entity_type,
    entity_id,
    action,
    actor_id,
    source,
    old_snapshot,
    new_snapshot
  ) VALUES (
    TG_TABLE_NAME,
    v_entity_id,
    TG_OP,
    auth.uid(),
    COALESCE(current_setting('app.audit_source', true), 'database'),
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_store_development_change()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_store_development_change()
  TO service_role;

CREATE OR REPLACE FUNCTION public.promote_store_development_to_location(
  p_project_id uuid,
  p_location_kind text DEFAULT 'shop'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project public.store_development_projects%ROWTYPE;
  v_location_id uuid;
BEGIN
  IF NOT public.can_manage_store_development(auth.uid())
     AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_location_kind NOT IN ('warehouse', 'shop') THEN
    RAISE EXCEPTION 'invalid_location_kind' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_project
  FROM public.store_development_projects
  WHERE id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_project.project_kind <> 'formal' OR v_project.status <> 'opened' THEN
    RAISE EXCEPTION 'project_not_opened' USING ERRCODE = '23514';
  END IF;

  IF v_project.location_id IS NOT NULL THEN
    RETURN v_project.location_id;
  END IF;

  INSERT INTO public.inv_locations (kind, name, notes)
  VALUES (
    p_location_kind,
    v_project.name,
    '由门店开发项目 ' || v_project.id::text || ' 开业转入'
  )
  RETURNING id INTO v_location_id;

  UPDATE public.store_development_projects
  SET location_id = v_location_id,
      updated_by = auth.uid(),
      updated_at = now()
  WHERE id = p_project_id;

  RETURN v_location_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.promote_store_development_to_location(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promote_store_development_to_location(uuid, text)
  TO authenticated, service_role;

ALTER TABLE public.store_development_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_development_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_development_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_development_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_development_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_development_contract_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_development_ai_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_development_audit_logs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'store_development_projects',
    'store_development_stages',
    'store_development_tasks',
    'store_development_attachments',
    'store_development_costs',
    'store_development_contract_analyses',
    'store_development_ai_logs',
    'store_development_audit_logs'
  ]
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      v_table || '_hq_read',
      v_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.can_manage_store_development(auth.uid()))',
      v_table || '_hq_read',
      v_table
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      v_table || '_hq_write',
      v_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.can_manage_store_development(auth.uid())) WITH CHECK (public.can_manage_store_development(auth.uid()))',
      v_table || '_hq_write',
      v_table
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.store_development_projects,
  public.store_development_stages,
  public.store_development_tasks,
  public.store_development_attachments,
  public.store_development_costs,
  public.store_development_contract_analyses,
  public.store_development_ai_logs
TO authenticated;

GRANT SELECT ON public.store_development_audit_logs TO authenticated;
GRANT ALL ON
  public.store_development_projects,
  public.store_development_stages,
  public.store_development_tasks,
  public.store_development_attachments,
  public.store_development_costs,
  public.store_development_contract_analyses,
  public.store_development_ai_logs,
  public.store_development_audit_logs
TO service_role;
GRANT USAGE, SELECT ON SEQUENCE
  public.store_development_audit_logs_id_seq
TO service_role;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'store_development_projects',
    'store_development_stages',
    'store_development_tasks',
    'store_development_attachments',
    'store_development_costs',
    'store_development_contract_analyses',
    'store_development_ai_logs'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON public.%I',
      v_table || '_updated_at',
      v_table
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()',
      v_table || '_updated_at',
      v_table
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON public.%I',
      v_table || '_audit',
      v_table
    );
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_store_development_change()',
      v_table || '_audit',
      v_table
    );
  END LOOP;
END
$$;

CREATE OR REPLACE VIEW public.store_development_project_summaries
WITH (security_invoker = true)
AS
SELECT
  p.*,
  COALESCE(c.expense_amount, 0)::numeric(14, 2) AS actual_expense_amount,
  COALESCE(c.deposit_amount, 0)::numeric(14, 2) AS actual_deposit_amount,
  COALESCE(c.total_paid_amount, 0)::numeric(14, 2) AS total_paid_amount,
  GREATEST(p.budget_amount - COALESCE(c.expense_amount, 0), 0)
    ::numeric(14, 2) AS remaining_budget_amount
FROM public.store_development_projects p
LEFT JOIN (
  SELECT
    project_id,
    SUM(amount - deposit_amount) AS expense_amount,
    SUM(deposit_amount) AS deposit_amount,
    SUM(amount) AS total_paid_amount
  FROM public.store_development_costs
  GROUP BY project_id
) c ON c.project_id = p.id;

GRANT SELECT ON public.store_development_project_summaries
  TO authenticated, service_role;

COMMENT ON TABLE public.store_development_projects IS
  '门店开发项目主表；候选点位和建设项目在开业前不得写入 inv_locations。';
COMMENT ON COLUMN public.store_development_projects.location_id IS
  '仅在项目状态为 opened 后绑定 ERP 经营库位。';
COMMENT ON COLUMN public.store_development_projects.legacy_document IS
  '保留 BOOMER OPEN 原始 JSON，确保迁移可逆且不丢未知字段。';
COMMENT ON TABLE public.store_development_attachments IS
  '附件元数据。历史文件继续保存在腾讯 COS，不在迁移时复制二进制对象。';
