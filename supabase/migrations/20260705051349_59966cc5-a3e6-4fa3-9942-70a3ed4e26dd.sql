ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS default_shop_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];

COMMENT ON COLUMN public.inv_skus.default_shop_ids IS
  '仓库建品时预设的铺货门店（空数组=铺给所有 branch）。Round B 铺货 worker 消费。';