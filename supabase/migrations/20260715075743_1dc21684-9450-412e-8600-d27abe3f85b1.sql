-- BOOMER-OFF AI product classification and structured product metadata.
WITH roots(code, name, sort_order) AS (
  VALUES
    ('porcelain', '瓷器', 10),
    ('tableware_other', '其他餐厨器皿', 20),
    ('toy_model', '玩具模型', 30),
    ('audio_media', '唱片影音', 40),
    ('digital_appliance', '数码电器', 50),
    ('home_decor', '家居陈设', 60),
    ('stationery_publication', '文具书刊', 70),
    ('fashion_wearable', '服饰穿戴', 80),
    ('art_collectible', '艺术收藏', 90),
    ('daily_misc', '日用杂货', 100),
    ('classification_pending', '待归类', 9990)
)
INSERT INTO public.inv_categories (
  code, name, parent_id, sort_order, is_active, is_system, kind
)
SELECT code, name, NULL, sort_order, true, true, 'category'
FROM roots
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  parent_id = NULL,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  is_system = true,
  kind = 'category',
  updated_at = now();

WITH children(code, name, parent_code, sort_order) AS (
  VALUES
    ('porcelain_japan', '日本瓷器', 'porcelain', 11),
    ('porcelain_europe', '欧洲瓷器', 'porcelain', 12),
    ('porcelain_china', '中国瓷器', 'porcelain', 13),
    ('porcelain_asia_other', '其他亚洲瓷器', 'porcelain', 14),
    ('porcelain_other_region', '其他地区瓷器', 'porcelain', 15),
    ('porcelain_origin_unknown', '产地待确认', 'porcelain', 19),

    ('tableware_glass', '玻璃器皿', 'tableware_other', 21),
    ('tableware_metal', '金属器皿', 'tableware_other', 22),
    ('tableware_enamel', '搪瓷器皿', 'tableware_other', 23),
    ('tableware_wood_bamboo', '木竹器皿', 'tableware_other', 24),
    ('tableware_plastic_acrylic', '塑料/亚克力器皿', 'tableware_other', 25),
    ('tableware_kitchen_tool', '厨房工具', 'tableware_other', 26),

    ('toy_character_figure', '角色人偶/软胶', 'toy_model', 31),
    ('toy_tin_clockwork', '铁皮发条', 'toy_model', 32),
    ('toy_vehicle_model', '车船模型', 'toy_model', 33),
    ('toy_building_model', '拼装积木', 'toy_model', 34),
    ('toy_plush', '毛绒布偶', 'toy_model', 35),
    ('toy_board_card', '桌游卡牌', 'toy_model', 36),
    ('toy_capsule_mini', '扭蛋食玩', 'toy_model', 37),

    ('audio_vinyl', '黑胶唱片', 'audio_media', 41),
    ('audio_cd', 'CD/SACD', 'audio_media', 42),
    ('audio_cassette', '磁带/卡带', 'audio_media', 43),
    ('audio_video_disc', '录像/影碟', 'audio_media', 44),
    ('audio_instrument', '乐器/音乐器材', 'audio_media', 45),
    ('audio_merchandise', '音乐周边', 'audio_media', 46),

    ('digital_camera', '相机摄像', 'digital_appliance', 51),
    ('digital_audio_player', '音响/播放器', 'digital_appliance', 52),
    ('digital_game_console', '游戏机/掌机', 'digital_appliance', 53),
    ('digital_communication', '通讯设备', 'digital_appliance', 54),
    ('digital_computer_office', '电脑/办公', 'digital_appliance', 55),
    ('digital_small_appliance', '生活小家电', 'digital_appliance', 56),
    ('digital_accessory', '配件耗材', 'digital_appliance', 57),

    ('home_lighting', '灯具照明', 'home_decor', 61),
    ('home_clock', '钟表', 'home_decor', 62),
    ('home_vase_ornament', '花器摆件', 'home_decor', 63),
    ('home_storage', '收纳容器', 'home_decor', 64),
    ('home_mirror_frame', '镜框相框', 'home_decor', 65),
    ('home_wall_decor', '墙面装饰', 'home_decor', 66),
    ('home_small_furniture', '小型家具', 'home_decor', 67),

    ('stationery_writing', '书写工具', 'stationery_publication', 71),
    ('stationery_desk', '桌面文具', 'stationery_publication', 72),
    ('stationery_notebook', '本册纸品', 'stationery_publication', 73),
    ('publication_book', '书籍', 'stationery_publication', 74),
    ('publication_magazine', '杂志画册', 'stationery_publication', 75),
    ('publication_poster', '海报印刷', 'stationery_publication', 76),
    ('publication_postcard_ticket', '票证/明信片', 'stationery_publication', 77),

    ('fashion_clothing', '服装', 'fashion_wearable', 81),
    ('fashion_shoes', '鞋靴', 'fashion_wearable', 82),
    ('fashion_bag', '包袋', 'fashion_wearable', 83),
    ('fashion_hat_scarf', '帽子/围巾', 'fashion_wearable', 84),
    ('fashion_eyewear', '眼镜', 'fashion_wearable', 85),
    ('fashion_jewelry', '首饰', 'fashion_wearable', 86),
    ('fashion_watch', '腕表', 'fashion_wearable', 87),

    ('art_paint_print', '绘画版画', 'art_collectible', 91),
    ('art_sculpture', '雕塑工艺', 'art_collectible', 92),
    ('art_folk_craft', '民艺手作', 'art_collectible', 93),
    ('collectible_badge_medal', '徽章奖牌', 'art_collectible', 94),
    ('collectible_stamp', '邮票邮品', 'art_collectible', 95),
    ('collectible_coin_souvenir', '钱币/纪念品', 'art_collectible', 96),

    ('daily_cleaning', '清洁护理', 'daily_misc', 101),
    ('daily_beauty_fragrance', '美妆香氛', 'daily_misc', 102),
    ('daily_hardware_tool', '工具五金', 'daily_misc', 103),
    ('daily_travel_outdoor', '旅行户外', 'daily_misc', 104),
    ('daily_pet', '宠物用品', 'daily_misc', 105),
    ('daily_other', '其他生活小物', 'daily_misc', 106),

    ('ai_low_confidence', 'AI低置信度', 'classification_pending', 9991),
    ('new_category_candidate', '新品类候选', 'classification_pending', 9992),
    ('compliance_review', '合规待审', 'classification_pending', 9993)
)
INSERT INTO public.inv_categories (
  code, name, parent_id, sort_order, is_active, is_system, kind
)
SELECT c.code, c.name, p.id, c.sort_order, true, true, 'category'
FROM children c
JOIN public.inv_categories p ON p.code = c.parent_code
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  parent_id = EXCLUDED.parent_id,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  is_system = true,
  kind = 'category',
  updated_at = now();

UPDATE public.inv_categories
SET is_active = false, updated_at = now()
WHERE code IN (
  'jp_porcelain', 'eu_porcelain', 'vintage_toy', 'anime_goods', 'media',
  'digital', 'jewelry', 'fashion', 'daily', 'antique'
);

ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS category_source text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS category_confidence numeric,
  ADD COLUMN IF NOT EXISTS classification_status text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS ai_suggested_price numeric(12,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_skus_category_source_check') THEN
    ALTER TABLE public.inv_skus ADD CONSTRAINT inv_skus_category_source_check
      CHECK (category_source IN ('ai','manual','import','legacy'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_skus_category_confidence_check') THEN
    ALTER TABLE public.inv_skus ADD CONSTRAINT inv_skus_category_confidence_check
      CHECK (category_confidence IS NULL OR category_confidence BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_skus_classification_status_check') THEN
    ALTER TABLE public.inv_skus ADD CONSTRAINT inv_skus_classification_status_check
      CHECK (classification_status IN ('legacy','auto_classified','fallback','corrected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_skus_ai_suggested_price_check') THEN
    ALTER TABLE public.inv_skus ADD CONSTRAINT inv_skus_ai_suggested_price_check
      CHECK (ai_suggested_price IS NULL OR ai_suggested_price >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.inv_sku_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid REFERENCES public.inv_skus(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'erp',
  image_count integer NOT NULL DEFAULT 0 CHECK (image_count BETWEEN 0 AND 8),
  category_code text NOT NULL,
  predicted_category_code text,
  confidence numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  alternative_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  model text NOT NULL,
  prompt_version text NOT NULL,
  taxonomy_version text NOT NULL,
  status text NOT NULL DEFAULT 'completed' CHECK (
    status IN ('completed','fallback','failed','corrected')
  ),
  warning text,
  corrected_category_code text,
  corrected_by uuid,
  corrected_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.inv_skus
  ADD COLUMN IF NOT EXISTS recognition_request_id uuid
  REFERENCES public.inv_sku_classifications(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inv_sku_classifications_sku
  ON public.inv_sku_classifications(sku_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_sku_classifications_category
  ON public.inv_sku_classifications(category_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_sku_classifications_status
  ON public.inv_sku_classifications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_skus_recognition_request
  ON public.inv_skus(recognition_request_id)
  WHERE recognition_request_id IS NOT NULL;

DROP TRIGGER IF EXISTS inv_sku_classifications_updated_at
  ON public.inv_sku_classifications;
CREATE TRIGGER inv_sku_classifications_updated_at
  BEFORE UPDATE ON public.inv_sku_classifications
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inv_sku_classifications TO authenticated;
GRANT ALL ON public.inv_sku_classifications TO service_role;

ALTER TABLE public.inv_sku_classifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'inv_sku_classifications'
      AND policyname = 'inv_sku_classifications_service_role_all'
  ) THEN
    CREATE POLICY inv_sku_classifications_service_role_all
      ON public.inv_sku_classifications
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'inv_sku_classifications'
      AND policyname = 'inv_sku_classifications_authenticated_read'
  ) THEN
    CREATE POLICY inv_sku_classifications_authenticated_read
      ON public.inv_sku_classifications
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;