
CREATE TABLE public.inv_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  parent_id uuid NULL REFERENCES public.inv_categories(id) ON DELETE SET NULL,
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  youzan_hq_category_id bigint NULL UNIQUE,
  youzan_shop_id uuid NULL REFERENCES public.youzan_shops(id) ON DELETE SET NULL,
  synced_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inv_categories_parent_idx ON public.inv_categories(parent_id);
CREATE INDEX inv_categories_active_idx ON public.inv_categories(is_active);

GRANT SELECT ON public.inv_categories TO authenticated;
GRANT ALL ON public.inv_categories TO service_role;

ALTER TABLE public.inv_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "categories_read_all_auth" ON public.inv_categories
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "categories_hq_write" ON public.inv_categories
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'hq_operator'));

CREATE TRIGGER inv_categories_updated_at
  BEFORE UPDATE ON public.inv_categories
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- Seed 10 hardcoded categories
INSERT INTO public.inv_categories (code, name, sort_order, is_system) VALUES
  ('jp_porcelain', '日本瓷器', 10, true),
  ('eu_porcelain', '欧洲瓷器', 20, true),
  ('vintage_toy',  '中古玩具', 30, true),
  ('anime_goods',  '二次元周边', 40, true),
  ('media',        '音像制品', 50, true),
  ('digital',      '数码家电', 60, true),
  ('jewelry',      '珠宝首饰', 70, true),
  ('fashion',      '时尚配件', 80, true),
  ('daily',        '日用杂货', 90, true),
  ('antique',      '古美术',   100, true);
