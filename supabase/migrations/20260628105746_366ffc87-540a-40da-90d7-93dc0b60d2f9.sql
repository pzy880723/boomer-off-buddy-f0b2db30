
CREATE TABLE public.org_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  receiver_name text,
  receiver_phone text,
  address text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_addresses TO authenticated;
GRANT ALL ON public.org_addresses TO service_role;

ALTER TABLE public.org_addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read addresses" ON public.org_addresses FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth insert addresses" ON public.org_addresses FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth update addresses" ON public.org_addresses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth delete addresses" ON public.org_addresses FOR DELETE TO authenticated USING (true);

CREATE UNIQUE INDEX org_addresses_only_one_default
  ON public.org_addresses ((true))
  WHERE is_default = true;

CREATE TRIGGER trg_org_addresses_updated_at
  BEFORE UPDATE ON public.org_addresses
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
