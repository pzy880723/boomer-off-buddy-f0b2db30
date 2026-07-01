
CREATE TABLE public.inv_label_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  width_mm numeric NOT NULL DEFAULT 53,
  height_mm numeric NOT NULL DEFAULT 35,
  elements jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX inv_label_templates_only_one_default
  ON public.inv_label_templates (is_default) WHERE is_default = true;

GRANT SELECT ON public.inv_label_templates TO authenticated;
GRANT ALL ON public.inv_label_templates TO service_role;

ALTER TABLE public.inv_label_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone signed in can read templates"
  ON public.inv_label_templates FOR SELECT TO authenticated USING (true);

CREATE POLICY "HQ can manage templates"
  ON public.inv_label_templates FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

CREATE TRIGGER inv_label_templates_set_updated_at
  BEFORE UPDATE ON public.inv_label_templates
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
