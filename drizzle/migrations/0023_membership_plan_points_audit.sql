CREATE TABLE public.commerce_membership_plan_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.commerce_membership_plans(id) ON DELETE RESTRICT,
  plan_code text NOT NULL,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  reason text,
  changed_by text NOT NULL DEFAULT current_user,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.commerce_membership_plan_audit_logs TO service_role;
GRANT SELECT ON public.commerce_membership_plan_audit_logs TO authenticated;
ALTER TABLE public.commerce_membership_plan_audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "super_admin reads plan audit" ON public.commerce_membership_plan_audit_logs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'super_admin'));

CREATE OR REPLACE FUNCTION public.commerce_audit_membership_plan_points()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (OLD.points_redemption_enabled, OLD.points_redemption_cap_rate,
      OLD.points_redemption_points_per_unit, OLD.points_redemption_unit_fen, OLD.policy_version)
     IS DISTINCT FROM
     (NEW.points_redemption_enabled, NEW.points_redemption_cap_rate,
      NEW.points_redemption_points_per_unit, NEW.points_redemption_unit_fen, NEW.policy_version) THEN
    INSERT INTO public.commerce_membership_plan_audit_logs(plan_id, plan_code, before_value, after_value, reason)
    VALUES (NEW.id, NEW.code,
      jsonb_build_object('enabled', OLD.points_redemption_enabled, 'cap_rate', OLD.points_redemption_cap_rate,
        'points_per_unit', OLD.points_redemption_points_per_unit, 'unit_fen', OLD.points_redemption_unit_fen,
        'policy_version', OLD.policy_version),
      jsonb_build_object('enabled', NEW.points_redemption_enabled, 'cap_rate', NEW.points_redemption_cap_rate,
        'points_per_unit', NEW.points_redemption_points_per_unit, 'unit_fen', NEW.points_redemption_unit_fen,
        'policy_version', NEW.policy_version),
      NULLIF(current_setting('app.plan_change_reason', true), ''));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.commerce_audit_membership_plan_points() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_commerce_membership_plan_points_audit
  AFTER UPDATE ON public.commerce_membership_plans
  FOR EACH ROW EXECUTE FUNCTION public.commerce_audit_membership_plan_points();