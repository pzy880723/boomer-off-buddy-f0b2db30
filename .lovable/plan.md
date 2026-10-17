# 只读核查结果：商品尺寸无反应 / 英文属性 / 图文详情（不改代码、不部署）

## 1. 版本差异
- 当前远端 HEAD：`82aba4ed`（统一了无库存/跨店 403），前序 `369b15a1`、`f280d608`。
- Tencent 已知版本 `2e2fda6b` → HEAD：494 个文件变化，+30240/-974。迁移 0066–0074 全部只在 Lovable Cloud；Tencent 未迁移、未部署。
- 推论：如果客户用的“新预览”连的是 Tencent 数据，尺寸接口和 0071–0074 的数据库步骤在那边都不存在，所以“点了无反应”很可能就是这个原因。这一点还没有确认，要看小程序当时请求的地址和返回码。

## 2. 英文属性名来源（已确认一半）
- 店面详情的属性来自 `src/server/storefront-products.server.ts:417-418,498-507`，查的是 `inv_sku_facets → inv_facets(code, name, dimension)`。原样返回 `dimension` 和 `code`，**不带中文维度名**。
- Lovable Cloud 只读统计：`inv_facets.name` 基本是中文；只有 character 维度 2 个、series 维度 1 个是英文原名，比如 "Noritake 职业系列"。`dimension` 的值都是英文键：material / craft / origin / object_type / era / style / function / release_method / ip / series / character。
- 结论：客户看到的“材质/类型/原产地/craft”，是展示端把 `dimension` 当成标题直接显示了。数据库里的值大多已经是中文。不过前端代码不在本仓库，这一点还没有验证。
- ERP 端：`src/components/inventory/sku-meta-fields.tsx:45-49,127-134` 直接拼 attributes 的值，没有统一的字段字典。识别提示词 `product-recognition.server.ts:331,343` 用的是英文键，值可能混入英文，例如 Heisei。
- 仓库里没有统一的“维度键→中文名”字典。`src/lib/product-taxonomy.ts:4-7` 只有键列表。

## 3. 商品说明 / 图文详情
- 已有：`product-content.server.ts` 管理草稿和发布版本；店面接口返回 `detail_content`（只有 published_blocks）和 `detail_content_version`（`products.$id.ts:87-92`）。内容块只有 heading / paragraph / facts / image 四种纯文本类型，并拒绝 URL 和 HTML（`src/lib/product-content.ts`）。
- 自动文案：`product-content.server.ts:141` 有禁词过滤，含限量、官方、来源、19xx 年等，会直接挡掉“历史故事”类说法。
- 缺口：内容块没有来源或证据字段，所以“有据的历史故事”目前无法和证据一起存。品牌介绍也没有独立的来源字段。

## 4. 尺寸公开接口契约（以当前代码为准）
- `GET /api/public/storefront/products/{id}` → `measurement`：没有实测时为 null；有实测但图片还没好时，diagram 为 pending 或 failed；图片好了才给 ready 和相对地址 `/api/public/media/measurement/...`。
- `POST .../products/{id}/measurement-requests`：需要顾客登录。返回 pending / completed / unavailable（附中文提示）；商品不存在返回 404；其他错误统一返回中文 500。

## 5. 建议（等你和客户确认后再实施）
1. 尺寸无反应：先查小程序请求的地址、状态码和 `status`。如果连的是 Tencent，要等 0066–0074 和代码部署之后才能用。
2. 中文化：建一份共享字段字典，店面返回时附带 `dimension_label`；未知的键不显示，不回退显示英文原文。ERP 用同一份字典。
3. 图文详情：增加 brand_intro / history 类型的内容块，带 `sources[]`（官方链接或文档、核实人、时间）。没有来源的历史段落不能发布，AI 只能生成草稿。

## 6. 测试缺口
- 店面详情接口没有测试断言属性字段里没有英文键。
- 没有字典覆盖测试，即每个 dimension 都要有中文名。
- 没有测试保证历史故事类内容块没有来源就不能发布。
- 没有小程序侧尺寸按钮的端到端测试；Tencent 也没有尺寸接口的冒烟测试。

## 未知
- 客户实际连的是哪套后台。
- 前端（小程序）在哪个文件渲染属性标题，代码不在本仓库。
- Tencent 的 inv_facets 数据。
