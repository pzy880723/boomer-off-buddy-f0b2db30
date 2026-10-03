-- Explicit optional characters, separate from company/manufacturer brands.
-- Catalog sources: https://www.sanrio.com/pages/character-goodies
-- https://www.sanrio.co.jp/characters/ and https://store.disney.co.jp/characters-list.html
BEGIN;
SET LOCAL lock_timeout = '5s';

WITH seeds(code,name,aliases,sort_order) AS (VALUES
  ('character_hello_kitty', 'Hello Kitty', ARRAY['凯蒂猫','HelloKitty','ハローキティ']::text[], 10),
  ('character_kuromi', '酷洛米', ARRAY['库洛米','Kuromi','クロミ']::text[], 11),
  ('character_my_melody', '美乐蒂', ARRAY['My Melody','マイメロディ']::text[], 12),
  ('character_cinnamoroll', '大耳狗', ARRAY['玉桂狗','Cinnamoroll','シナモロール']::text[], 13),
  ('character_pompompurin', '布丁狗', ARRAY['Pompompurin','ポムポムプリン']::text[], 14),
  ('character_pochacco', '帕恰狗', ARRAY['Pochacco','ポチャッコ']::text[], 15),
  ('character_keroppi', '可洛比', ARRAY['大眼蛙','Keroppi','けろけろけろっぴ']::text[], 16),
  ('character_badtz_maru', '酷企鹅', ARRAY['坏坏丸','Badtz-maru','バッドばつ丸']::text[], 17),
  ('character_tuxedosam', '山姆企鹅', ARRAY['Tuxedosam','タキシードサム']::text[], 18),
  ('character_little_twin_stars', '双子星', ARRAY['Kiki Lala','Little Twin Stars','リトルツインスターズ']::text[], 19),
  ('character_gudetama', '蛋黄哥', ARRAY['Gudetama','ぐでたま']::text[], 20),
  ('character_hangyodon', '半鱼人', ARRAY['人鱼汉顿','Hangyodon','ハンギョドン']::text[], 21),
  ('character_my_sweet_piano', '钢琴酱', ARRAY['My Sweet Piano','マイスウィートピアノ']::text[], 22),
  ('character_cogimyun', '小麦粉精灵', ARRAY['Cogimyun','こぎみゅん']::text[], 23),
  ('character_pekkle', '贝克鸭', ARRAY['Pekkle','あひるのペックル']::text[], 24),
  ('character_chococat', '巧克力猫', ARRAY['Chococat']::text[], 25),
  ('character_charmmy_kitty', '恰咪猫', ARRAY['Charmmy Kitty']::text[], 26),
  ('character_dear_daniel', '丹尼尔', ARRAY['Dear Daniel']::text[], 27),
  ('character_marroncream', '玛伦奶油兔', ARRAY['Marroncream','マロンクリーム']::text[], 28),
  ('character_usahana', '花小兔', ARRAY['U*SA*HA*NA','Usahana','ウサハナ']::text[], 29),
  ('character_corocorokuririn', '可乐铃', ARRAY['Corocorokuririn','コロコロクリリン']::text[], 30),
  ('character_kirimichan', '切片鱼', ARRAY['Kirimichan','KIRIMIちゃん']::text[], 31),
  ('character_aggretsuko', '烈子', ARRAY['Aggretsuko','アグレッシブ烈子']::text[], 32),
  ('character_hanamaruobake', '花丸幽灵', ARRAY['Hanamaruobake','はなまるおばけ']::text[], 33),
  ('character_lloromannic', '罗罗小恶魔', ARRAY['Lloromannic','ルロロマニック']::text[], 34),
  ('character_lovelymocha', '摩卡', ARRAY['Lovelymocha','Mocha','モカ']::text[], 35),
  ('character_gaopowerroo', 'Gaopowerroo', ARRAY['がおぱわるぅ']::text[], 36),
  ('character_monkichi', '淘气猴', ARRAY['Monkichi','おさるのもんきち']::text[], 37),
  ('character_minna_no_tabo', '大宝', ARRAY['Minna no Tabo','みんなのたあ坊']::text[], 38),
  ('character_patty_jimmy', '帕蒂与吉米', ARRAY['Patty & Jimmy','パティ&ジミー']::text[], 39),
  ('character_sugarbunnies', '砂糖兔', ARRAY['Sugarbunnies','シュガーバニーズ']::text[], 40),
  ('character_mickey', '米奇', ARRAY['Mickey Mouse','米老鼠']::text[], 41),
  ('character_minnie', '米妮', ARRAY['Minnie Mouse']::text[], 42),
  ('character_donald', '唐老鸭', ARRAY['Donald Duck']::text[], 43),
  ('character_daisy', '黛丝', ARRAY['Daisy Duck']::text[], 44),
  ('character_goofy', '高飞', ARRAY['Goofy']::text[], 45),
  ('character_pluto', '布鲁托', ARRAY['Pluto']::text[], 46),
  ('character_chip', '奇奇', ARRAY['Chip']::text[], 47),
  ('character_dale', '蒂蒂', ARRAY['Dale']::text[], 48),
  ('character_winnie_the_pooh', '小熊维尼', ARRAY['Winnie the Pooh','Pooh']::text[], 49),
  ('character_piglet', '小猪皮杰', ARRAY['Piglet']::text[], 50),
  ('character_tigger', '跳跳虎', ARRAY['Tigger']::text[], 51),
  ('character_eeyore', '屹耳', ARRAY['Eeyore']::text[], 52),
  ('character_stitch', '史迪奇', ARRAY['Stitch','史迪仔']::text[], 53),
  ('character_angel', '安琪', ARRAY['Angel','安琪拉']::text[], 54),
  ('character_marie', '玛丽猫', ARRAY['Marie']::text[], 55),
  ('character_dumbo', '小飞象', ARRAY['Dumbo']::text[], 56),
  ('character_bambi', '小鹿斑比', ARRAY['Bambi']::text[], 57),
  ('character_thumper', '桑普', ARRAY['Thumper']::text[], 58),
  ('character_alice', '爱丽丝', ARRAY['Alice']::text[], 59),
  ('character_cheshire_cat', '柴郡猫', ARRAY['Cheshire Cat']::text[], 60),
  ('character_ariel', '爱丽儿', ARRAY['Ariel','小美人鱼']::text[], 61),
  ('character_belle', '贝儿', ARRAY['Belle']::text[], 62),
  ('character_cinderella', '灰姑娘', ARRAY['Cinderella','仙蒂']::text[], 63),
  ('character_snow_white', '白雪公主', ARRAY['Snow White']::text[], 64),
  ('character_aurora', '爱洛', ARRAY['Aurora','睡美人']::text[], 65),
  ('character_jasmine', '茉莉', ARRAY['Jasmine']::text[], 66),
  ('character_rapunzel', '乐佩', ARRAY['Rapunzel','长发公主']::text[], 67),
  ('character_elsa', '艾莎', ARRAY['Elsa']::text[], 68),
  ('character_anna', '安娜', ARRAY['Anna']::text[], 69),
  ('character_olaf', '雪宝', ARRAY['Olaf']::text[], 70),
  ('character_mulan', '花木兰', ARRAY['Mulan']::text[], 71),
  ('character_moana', '莫阿娜', ARRAY['Moana']::text[], 72),
  ('character_tinker_bell', '小叮当', ARRAY['Tinker Bell','奇妙仙子']::text[], 73),
  ('character_peter_pan', '彼得潘', ARRAY['Peter Pan']::text[], 74),
  ('character_pinocchio', '匹诺曹', ARRAY['Pinocchio']::text[], 75),
  ('character_simba', '辛巴', ARRAY['Simba']::text[], 76),
  ('character_judy', '朱迪', ARRAY['Judy Hopps']::text[], 77),
  ('character_nick', '尼克', ARRAY['Nick Wilde']::text[], 78),
  ('character_baymax', '大白', ARRAY['Baymax']::text[], 79),
  ('character_woody', '胡迪', ARRAY['Woody']::text[], 80),
  ('character_buzz_lightyear', '巴斯光年', ARRAY['Buzz Lightyear']::text[], 81),
  ('character_alien', '三眼仔', ARRAY['Alien','Little Green Men']::text[], 82),
  ('character_lotso', '草莓熊', ARRAY['Lotso']::text[], 83),
  ('character_sulley', '毛怪', ARRAY['Sulley']::text[], 84),
  ('character_mike_wazowski', '大眼仔', ARRAY['Mike Wazowski']::text[], 85),
  ('character_nemo', '尼莫', ARRAY['Nemo']::text[], 86),
  ('character_dory', '多莉', ARRAY['Dory']::text[], 87),
  ('character_lightning_mcqueen', '闪电麦昆', ARRAY['Lightning McQueen']::text[], 88)
)
INSERT INTO public.inv_facets(code,name,dimension,aliases,sort_order,is_active,is_system)
SELECT code,name,'character',aliases,sort_order,true,true FROM seeds
ON CONFLICT DO NOTHING;
-- Add searchable aliases without renaming existing taxonomy or reactivating disabled entries.
UPDATE public.inv_facets SET aliases = ARRAY(
  SELECT DISTINCT value FROM unnest(coalesce(aliases,ARRAY[]::text[]) || ARRAY['库洛米','Kuromi','クロミ']) value)
WHERE code = 'character_kuromi' AND dimension = 'character';

ALTER TABLE public.commerce_order_items
  ADD COLUMN IF NOT EXISTS character_id uuid REFERENCES public.inv_facets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS character_name_snapshot text;
ALTER TABLE public.pos_held_cart_items
  ADD COLUMN IF NOT EXISTS character_id uuid REFERENCES public.inv_facets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS character_name_snapshot text;
DROP INDEX IF EXISTS public.pos_held_cart_items_line_key;
CREATE UNIQUE INDEX pos_held_cart_items_line_key ON public.pos_held_cart_items
  (held_cart_id, sku_id, coalesce(subcategory_code, ''), coalesce(brand_id::text, ''), coalesce(character_id::text, ''));

DO $migration$
DECLARE definition text; body_hash text;
BEGIN
  SELECT pg_get_functiondef(oid), md5(prosrc) INTO definition, body_hash FROM pg_proc
    WHERE oid = 'public.pos_complete_sale(uuid,uuid,text,jsonb,jsonb,uuid,text)'::regprocedure;
  IF position('v_character_name text;' in definition) = 0 THEN
    IF body_hash <> 'd7547794011d45503c85944e4af03c38' THEN RAISE EXCEPTION 'pos_character_sale_baseline_drift'; END IF;
    definition := replace(definition, '  v_brand_name text;', E'  v_brand_name text;\n  v_character_name text;');
    definition := replace(definition, $old$           ord
$old$, $new$           nullif(elem->>'character_id', '')::uuid AS character_id,
           ord
$new$);
    definition := replace(definition, $old$'74c76f9f-817b-4f5c-b02d-20acc5e8c10c'::uuid));$old$,
      $new$'74c76f9f-817b-4f5c-b02d-20acc5e8c10c'::uuid,
           'a2e45bd6-7e46-4483-83c0-3a092ac949a7'::uuid));$new$);
    definition := replace(definition, $old$    INSERT INTO public.commerce_order_items ($old$, $new$    v_character_name := NULL;
    IF v_item.character_id IS NOT NULL THEN
      SELECT name INTO v_character_name FROM public.inv_facets
       WHERE id = v_item.character_id AND is_active AND dimension = 'character';
      IF v_character_name IS NULL THEN RAISE EXCEPTION 'invalid_character'; END IF;
    END IF;

    INSERT INTO public.commerce_order_items ($new$);
    definition := replace(definition, $old$      brand_id, brand_name_snapshot
$old$, $new$      brand_id, brand_name_snapshot, character_id, character_name_snapshot
$new$);
    definition := replace(definition, $old$      v_item.brand_id, v_brand_name
$old$, $new$      v_item.brand_id, v_brand_name, v_item.character_id, v_character_name
$new$);
    definition := replace(definition, $old$'brand_id', item.brand_id, 'brand_name', item.brand_name_snapshot$old$,
      $new$'brand_id', item.brand_id, 'brand_name', item.brand_name_snapshot,
           'character_id', item.character_id, 'character_name', item.character_name_snapshot$new$);
    EXECUTE definition;
  END IF;
  SELECT pg_get_functiondef(oid), md5(prosrc) INTO definition, body_hash FROM pg_proc
    WHERE oid = 'public.pos_complete_sale_v3(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid,integer)'::regprocedure;
  IF position('character_name_snapshot' in definition) = 0 THEN
    IF body_hash <> 'c394a0313d263abdbdbc838cb7a4a962' THEN RAISE EXCEPTION 'pos_character_points_baseline_drift'; END IF;
    definition := replace(definition,
      $old$'brand_id',brand_id,'brand_name',brand_name_snapshot)$old$,
      $new$'brand_id',brand_id,'brand_name',brand_name_snapshot,
      'character_id',character_id,'character_name',character_name_snapshot)$new$);
    EXECUTE definition;
  END IF;
END;
$migration$;
NOTIFY pgrst, 'reload schema';
COMMIT;
