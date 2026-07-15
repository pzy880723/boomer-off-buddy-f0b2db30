## 目标
把 `inv_brands` 从 5 条扩展到约 200 条，覆盖 4 大类 + 动漫 IP，**每条都同时包含中文名和英文/日文原名**，UI 列表能一眼看到中英对照。

## 命名规范（关键调整）
所有品牌以「中文 + 原名」双语呈现：

| 字段 | 内容 | 示例 |
|---|---|---|
| `name` | 中文常用译名 + 空格 + 原名括号 | `美浓烧 (Mino-yaki)` / `迈森 (Meissen)` / `万代 (Bandai)` / `吉卜力工作室 (Studio Ghibli)` |
| `name_original` | 原文/原名（日文汉字、假名、拉丁字母） | `美濃焼` / `Meissen` / `バンダイ` / `スタジオジブリ` |
| `aliases` | 别名数组：纯中文、纯英文、旧名、拼写变体，方便搜索 | `["美浓","Mino","みの"]` / `["梅森","麦森","Meissener Porzellan"]` |
| `origin_country` | 中文国名 | `日本` / `德国` / `中国` |
| `brand_type` | 沿用现有枚举（窑口 / 品牌 / 制造商 / 工作室 / IP 等，按当前允许值） | — |
| `notes` | 一句中文简介：产地/主打品类/年代 | `日本岐阜县美浓地区陶瓷总称，日用餐具主力产地` |
| `status` | `active` | — |

已有的 5 条（Bandai / Nintendo / Noritake / Sony / Wedgwood）会用 `ON CONFLICT (name) DO NOTHING` 跳过，不覆盖你现在的数据。**注意**：如果你希望这 5 条也升级成"中文 (英文)"格式，我可以另加一步 UPDATE，请在批准时告诉我。

## 品类分配（约 200 条）
- **瓷器/陶器窑口 ~50**：日本（有田/九谷/美浓/濑户/京烧/清水/萨摩/伊万里/波佐见/砥部/益子/常滑/备前/信乐/丹波/越前/萩/唐津/小鹿田/香兰社/深川制磁/大仓陶园/则武/鸣海/Nikko/橘吉）、中国（景德镇/龙泉/钧/汝/定/耀州/磁州/德化/宜兴紫砂/建/吉州/湖田/醴陵/潮州）、欧洲（Meissen/Royal Copenhagen/Herend/Villeroy & Boch/Rosenthal/KPM Berlin/Sèvres/Limoges/Bernardaud/Haviland/Ginori 1735/Royal Doulton/Royal Albert/Minton/Spode/Portmeirion/Aynsley/Bing & Grøndahl/Arabia/Iittala/Rörstrand/Gustavsberg/Marimekko）
- **餐具/生活器物 ~35**：Narumi/Okura/Kinto/Hasami/松德硝子/木村硝子/柳宗理/Zwilling/WMF/Le Creuset/Staub/Lodge/Cristel/Fissler/Alessi/Georg Jensen/Christofle/Riedel/Baccarat/Lalique/Waterford/Orrefors/Kosta Boda/Holmegaard/Zalto/Spiegelau/Bodum 等
- **玩具/模型/动漫周边 ~50**：Bandai Spirits/Tamashii Nations/Megahouse/Kotobukiya/Good Smile Company/Max Factory/Alter/Aniplex/Kaiyodo/Revoltech/Figma/Medicom Toy/Be@rbrick/Hot Toys/Sideshow/S.H.Figuarts/Robot 魂/Metal Build/Tomy/Takara Tomy/Sylvanian Families/Transformers/Lego/Playmobil/Funko/Mattel/Hasbro/Sanrio/San-X/Pokémon Company/Studio Ghibli 周边（Benelic）/Union Creative/Prime 1 Studio/XM Studios/First 4 Figures/Ensky/Movic/Cospa/Bushiroad 等
- **数码/电器/相机/游戏机 ~30**：Sega/Panasonic/Sharp/Toshiba/Hitachi/Canon/Nikon/Fujifilm/OM System/Ricoh/Pentax/Leica/Hasselblad/Contax/Minolta/Casio/Seiko/Citizen/G-Shock/Bose/JBL/Sennheiser/Audio-Technica/Denon/Marantz/Yamaha/Microsoft Xbox/Atari/SNK
- **动漫 IP / 工作室 ~35**：Studio Ghibli/东映动画/Sunrise/Bones/MAPPA/ufotable/京都动画/Trigger/Madhouse/Production I.G/CLAMP/集英社/讲谈社/小学馆/Square Enix/Bandai Namco/Capcom/Konami/Level-5/Type-Moon/Aniplex/角川/Pierrot/Wit Studio/A-1 Pictures/Marvel/DC/迪士尼/皮克斯/Warner Bros. Animation/Cartoon Network/DreamWorks/Illumination/Rovio/Line Friends

## 写入方式
一份 SQL 迁移（其实是数据变更，会用 `supabase--insert`）：
```sql
INSERT INTO public.inv_brands
  (name, name_original, aliases, brand_type, origin_country, notes, status)
VALUES
  ('美浓烧 (Mino-yaki)', '美濃焼', ARRAY['美浓','Mino','みの'], '<窑口枚举值>', '日本', '岐阜县美浓地区陶瓷总称，日用餐具主力产地', 'active'),
  ...
ON CONFLICT (name) DO NOTHING;
```
- 先跑 `SELECT` 确认 `inv_brands.brand_type` 的实际允许值/常量，再按值填
- 幂等：重复执行不会重复插入
- 200 条一次性写入

## 验证
1. 打开 `/product-brands`
2. 搜索 `美浓` / `Meissen` / `吉卜力` / `Leica` / `万代` 每个都能命中
3. 列表卡片同时看到中文和原名

## 不做
- 不动 `inv_brands` 表结构
- 不动 UI 组件（当前 UI 已经会渲染 `name` + `name_original` + `aliases`；如果发现只显示英文，我会再调 UI）
- 不导入 Logo 图片
