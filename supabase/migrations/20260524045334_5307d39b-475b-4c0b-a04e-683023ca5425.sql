CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_select_app_settings" ON public.app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert_app_settings" ON public.app_settings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update_app_settings" ON public.app_settings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_delete_app_settings" ON public.app_settings FOR DELETE TO authenticated USING (true);

CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

INSERT INTO public.app_settings (key, value)
VALUES ('inv_price_tiers', '[6.9, 9.9, 15.9, 19.9, 29.9, 39.9, 49.9]'::jsonb)
ON CONFLICT (key) DO NOTHING;