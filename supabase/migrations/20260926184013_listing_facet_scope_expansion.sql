-- Repair retired scopes without replacing facet identities or SKU associations.
UPDATE public.inv_facets SET category_codes = ARRAY['porcelain_jp','porcelain_eu','porcelain_cartoon'], updated_at = now()
WHERE code IN ('craft_gilt','material_porcelain','material_bone_china') AND category_codes = ARRAY['porcelain'];
UPDATE public.inv_facets SET category_codes = ARRAY[]::text[], updated_at = now()
WHERE code = 'function_display' AND category_codes = ARRAY['porcelain_decor_figurine'];
UPDATE public.inv_facets SET category_codes = ARRAY['porcelain_drinkware','eu_porcelain_cup','porcelain_cartoon','tableware_glass'], updated_at = now()
WHERE code IN ('function_drinking','object_coffee_cup','object_mug','object_teacup') AND category_codes = ARRAY['porcelain_drinkware'];

-- Labels describe evidence, not a promise of rarity or authenticity. No SKU tags are auto-assigned.
WITH seed(code,name,dimension,aliases,category_codes) AS (VALUES
 ('material_glass','玻璃','material',ARRAY['玻璃制'],ARRAY[]::text[]),
 ('material_wood','木质','material',ARRAY['木头','木制'],ARRAY[]::text[]),
 ('material_plastic','塑料','material',ARRAY['树脂塑料'],ARRAY[]::text[]),
 ('material_resin','树脂','material',ARRAY['树脂制'],ARRAY[]::text[]),
 ('material_fabric','布艺','material',ARRAY['织物','布料'],ARRAY[]::text[]),
 ('material_plush','毛绒','material',ARRAY['绒毛'],ARRAY[]::text[]),
 ('material_paper','纸质','material',ARRAY['纸品'],ARRAY[]::text[]),
 ('material_acrylic','亚克力','material',ARRAY['亚克力制'],ARRAY[]::text[]),
 ('material_enamel','搪瓷','material',ARRAY['珐琅搪瓷'],ARRAY[]::text[]),
 ('material_stainless','不锈钢','material',ARRAY['stainless steel'],ARRAY[]::text[]),
 ('material_brass','黄铜','material',ARRAY['brass'],ARRAY[]::text[]),
 ('material_leather','皮革','material',ARRAY['leather'],ARRAY[]::text[]),
 ('object_plate','盘碟','object_type',ARRAY['盘子','碟子'],ARRAY['porcelain_jp','porcelain_eu','porcelain_cartoon','home_goods']),
 ('object_bowl','碗','object_type',ARRAY['饭碗','汤碗'],ARRAY['porcelain_jp','porcelain_eu','porcelain_cartoon','home_goods']),
 ('object_teapot','茶壶','object_type',ARRAY['壶具'],ARRAY['porcelain_jp','porcelain_eu','porcelain_cartoon','home_goods','art_collectible']),
 ('object_vase','花瓶','object_type',ARRAY['花器'],ARRAY['porcelain_jp','porcelain_eu','porcelain_cartoon','home_goods']),
 ('object_glass_cup','玻璃杯','object_type',ARRAY['威士忌杯','水杯'],ARRAY['tableware_glass']),
 ('object_figurine','摆件','object_type',ARRAY['公仔摆件'],ARRAY[]::text[]),
 ('object_plush','毛绒公仔','object_type',ARRAY['毛绒玩偶','布偶'],ARRAY['toy_model','character_ip_goods']),
 ('object_model','模型','object_type',ARRAY['模型玩具'],ARRAY['toy_model','character_ip_goods']),
 ('object_miniature','迷你模型','object_type',ARRAY['微缩','迷你屋','玩具屋'],ARRAY['toy_model']),
 ('object_keychain','钥匙扣','object_type',ARRAY['钥匙圈'],ARRAY['character_ip_goods','fashion_wearable','daily_misc']),
 ('object_charm','挂件','object_type',ARRAY['挂饰','吊饰'],ARRAY[]::text[]),
 ('object_music_box','音乐盒','object_type',ARRAY['八音盒'],ARRAY['toy_model','home_goods','audio_media']),
 ('object_clock','钟表','object_type',ARRAY['台钟','闹钟'],ARRAY['home_goods']),
 ('object_brooch','胸针','object_type',ARRAY['别针'],ARRAY['fashion_jewelry']),
 ('object_necklace','项链','object_type',ARRAY['吊坠项链'],ARRAY['fashion_jewelry']),
 ('object_bag','包袋','object_type',ARRAY['手提包','挎包'],ARRAY['fashion_wearable']),
 ('object_camera','相机','object_type',ARRAY['照相机'],ARRAY['digital_appliance']),
 ('object_player','播放器','object_type',ARRAY['随身听','磁带机'],ARRAY['digital_appliance']),
 ('object_record','唱片','object_type',ARRAY['黑胶','LP'],ARRAY['audio_media']),
 ('object_book','书刊','object_type',ARRAY['书籍','杂志'],ARRAY['stationery_publication']),
 ('object_postcard','明信片','object_type',ARRAY['postcard'],ARRAY['stationery_publication','character_ip_goods']),
 ('object_stationery','文具','object_type',ARRAY['书写工具'],ARRAY['stationery_publication','character_ip_goods']),
 ('function_storage','收纳','function',ARRAY['储物'],ARRAY[]::text[]),
 ('function_decoration','装饰','function',ARRAY['家居装饰'],ARRAY[]::text[]),
 ('function_dining','餐桌使用','function',ARRAY['餐具'],ARRAY['porcelain_jp','porcelain_eu','porcelain_cartoon','home_goods']),
 ('function_writing','书写','function',ARRAY['写字'],ARRAY['stationery_publication']),
 ('function_music','音乐播放','function',ARRAY['播放音乐'],ARRAY['digital_appliance','audio_media','toy_model','home_goods']),
 ('function_portable','随身携带','function',ARRAY['便携'],ARRAY[]::text[]),
 ('function_flower','插花','function',ARRAY['花艺'],ARRAY['porcelain_jp','porcelain_eu','home_goods','art_collectible']),
 ('style_floral','花卉图案','style',ARRAY['花纹','花朵'],ARRAY[]::text[]),
 ('style_geometric','几何图案','style',ARRAY['几何纹'],ARRAY[]::text[]),
 ('style_cartoon','卡通风格','style',ARRAY['卡通'],ARRAY[]::text[]),
 ('style_minimal','简约','style',ARRAY['极简'],ARRAY[]::text[]),
 ('style_colorful','多彩','style',ARRAY['彩色'],ARRAY[]::text[]),
 ('style_monochrome','单色','style',ARRAY['纯色'],ARRAY[]::text[]),
 ('style_japanese','和风','style',ARRAY['日式纹样'],ARRAY[]::text[]),
 ('style_mechanical','机械造型','style',ARRAY['机械风'],ARRAY[]::text[]),
 ('craft_relief','浮雕','craft',ARRAY['立体浮雕'],ARRAY[]::text[]),
 ('craft_embroidery','刺绣','craft',ARRAY['绣花'],ARRAY[]::text[]),
 ('craft_printed','印花','craft',ARRAY['图案印刷'],ARRAY[]::text[]),
 ('craft_woven','编织','craft',ARRAY['织造'],ARRAY[]::text[]),
 ('origin_france','法国','origin',ARRAY['France','Made in France'],ARRAY[]::text[]),
 ('origin_germany','德国','origin',ARRAY['Germany','Made in Germany'],ARRAY[]::text[]),
 ('origin_usa','美国','origin',ARRAY['USA','Made in USA'],ARRAY[]::text[]),
 ('character_hello_kitty','Hello Kitty','character',ARRAY['凯蒂猫','ハローキティ'],ARRAY[]::text[]),
 ('character_doraemon','哆啦A梦','character',ARRAY['Doraemon','ドラえもん'],ARRAY[]::text[]),
 ('character_snoopy','史努比','character',ARRAY['Snoopy'],ARRAY[]::text[]),
 ('character_miffy','米菲','character',ARRAY['Miffy'],ARRAY[]::text[]),
 ('character_my_melody','美乐蒂','character',ARRAY['My Melody'],ARRAY[]::text[]),
 ('character_kuromi','酷洛米','character',ARRAY['Kuromi'],ARRAY[]::text[]),
 ('character_cinnamoroll','大耳狗','character',ARRAY['Cinnamoroll','玉桂狗'],ARRAY[]::text[]),
 ('character_mickey','米奇','character',ARRAY['Mickey Mouse'],ARRAY[]::text[])
)
INSERT INTO public.inv_facets(code,name,dimension,aliases,category_codes,is_system,sort_order)
SELECT code,name,dimension,aliases,category_codes,true,100 FROM seed
ON CONFLICT DO NOTHING;
