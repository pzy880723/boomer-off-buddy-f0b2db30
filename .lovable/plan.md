# 小程序图片“默认只加载压缩图”只读审计 + 统一图片契约建议

审计基准 commit：`aea8deec66c39527ac569d2dfb0eff7f9ad7bd20`（工作区干净）。
本轮**未修改任何代码、数据库、配置**，未迁移、未部署。腾讯当前基线为 `1e7a4ee-cart-thumbnails-20260913`（仅详情路由带 thumbnail），下文“仓库状态”一律不等同于腾讯已部署。

## 1. 为小程序供图的全部入口（静态证据）

| 场景 | 接口 / 函数 | 文件:行 | 当前下发字段 | 是否压缩图 |
|---|---|---|---|---|
| 商品列表 | GET /api/public/storefront/products | `src/routes/api/public/storefront/products.ts:76`（thumbnail:true） | `image_url`(原图签名) `image_urls[]`(原图) `thumbnail_url`(480) | 部分：同时下发原图数组 |
| 商品详情/轮播/放大 | GET /api/public/storefront/products/$id → `buildStorefrontProductDetail` | `products.$id.ts:25`；`storefront-products.server.ts:242-318` | `image_url` `image_urls[]` `thumbnail_url` `image_previews[{image_url,preview_url}]` | 仓库已有 preview；**腾讯未部署 image_previews** |
| 列表/详情签名 | `signStorefrontProductImages` | `storefront-products.server.ts:196-222` | thumbs 失败→`image_url`（原图） | 有原图回退 |
| 订单列表 | GET /api/public/storefront/orders → `defaultSignPaths` | `storefront-order-list-query.server.ts:27,36-55`；组装 `storefront-order-list.server.ts:366` | 每 item 单一 `image_url` | 缩略图优先，**失败显式回退原图签名** |
| 订单详情 | GET /api/public/storefront/orders/$id | `orders.$id.ts:49-58` | `select("*")` 直出 `image_snapshot` 原值 | 否，无任何压缩 |
| 旧订单快照图源链 | `resolveItemImageRef` | `storefront-order-list.server.ts:445-484` | snapshot→listing.image_paths→cover_url→sku.image_paths→sku.image_url | `direct`（http/data）分支完全旁路签名与转换 |
| 门店图 | GET /api/public/storefront/shops → `signShopImages` | `storefront-shops.server.ts:100-108` | `createSignedUrls`，**无 transform** | 否，原图 |
| 头像 | `authenticateStorefrontCustomer` 写入/透出 `avatar_url` | `storefront-auth.server.ts:66` | 微信外链原图 | 否 |
| 品牌 logo | GET /api/public/storefront/taxonomy | `taxonomy.ts:23`；`storefront-products.server.ts:135,374` | `logo_url` 原值 | 否 |
| 社区/内容 | `toPublicContentDto` | `src/lib/content-public.ts:47-52` | `media.cover_url` `video_url` 原值 | 否 |
| 私有图代理 | GET /api/public/media/sku/$ | `src/routes/api/public/media/sku/$.ts:24-35` | 整字节流回源，无 width/quality 参数 | 否 |
| 客服上下文 | `src/server/support.server.ts` | — | 无任何图片字段（纯文本） | N/A，前端若渲染商品图需复用上表 |

## 2. 确认的能力与边界

- **转换能力存在且已在用**：`signSkuThumbnailPaths`（`sku-image-resolver.server.ts:81-131`）走 `createSignedUrl(path, ttl, {transform:{width:480,resize:contain,quality:75}})`，并发 4、去重、TTL 24h；私桶白名单见 `:10-16`（含 `parcel-item-images`）。另有纯前端 `toThumbUrl`（`src/lib/image.ts:8-20`，render/image 复用同 token），ERP 用、小程序未用。
- **腾讯新图路径不兼容转换**：`tencent-media-client.server.ts` 上传后用 `getPublicUrl` 产出**绝对 URL** 并入库；这类值在各处都落到 `direct` 分支（`storefront-order-list.server.ts:452`）或原样下发，既不签名也不缩放 → 新图天然是“永久原图”。历史 `parcel-item-images` 绝对 URL 同理。
- **鉴权边界**：私桶只经 service-role 签名或 `/api/public/media/sku` 代理；代理仅允许 `sku-raw`/`sku-listing`，拒绝 `..`（`sku-media.ts:20-32`），无重定向。订单侧强制 `customer_id` 归属过滤。
- **SSRF 边界**：目前服务端**不**按 URL 抓取外链，故无 SSRF；一旦新增“服务端转换外链”，必须域名白名单 + 禁私网/localhost + 禁重定向，否则会引入 SSRF。
- **越权风险提示（非本次范围）**：`orders.$id` 用 `select("*")` 会带出地址/电话等列，建议另立项收敛字段白名单。

## 3. 主要缺口（即“会加载原图”的真实原因）

1. 详情 `image_previews` 腾讯未部署 → 轮播与放大预览直接吃 `image_urls[]` 原图（实测 1.2MB+）。
2. 列表/详情仍**同时**下发完整原图数组，客户端任意取用即退化。
3. 订单列表缩略图失败 → 自动回退原图签名（`storefront-order-list-query.server.ts:48-55`），与“错误重试禁止回退原图”冲突。
4. 订单详情、门店图、头像、品牌 logo、社区封面**完全无压缩衍生图**。
5. `image_snapshot` / 腾讯新图 / 微信头像等外链一律旁路转换。
6. 媒体代理路由不支持尺寸参数，无法为公开桶生成衍生图。

## 4. 建议的最小统一图片契约（尚未实现，待批准后另立实施项）

统一一个可复用类型 `MediaImage`，所有面向小程序的图片字段一律返回它，替代裸 URL：

```text
MediaImage = {
  thumbnail_url: string        // 必返，列表/购物车/订单/客服/头像/社区默认唯一可用图（<=480w）
  preview_url:   string        // 放大预览默认图（<=1080w）
  original_url:  string | null // 仅“查看原图”按钮使用；不可用时 null
  degraded:      boolean       // true = 无法生成衍生图（外链/未知桶），客户端必须按占位处理
}
```

落地要点（最小改动顺序）：
1. 抽 `src/server/media-contract.server.ts`：`buildMediaImage(ref)`，内部只走既有 `signSkuThumbnailPaths`(480) / 新增 1080 档 / `signSkuImagePaths`，**不新增 SDK、不手拼签名**。
2. 失败语义改为：thumbnail 失败 → `degraded:true` 且 `thumbnail_url` 用占位，**绝不回退 original**（改 `storefront-order-list-query.server.ts:36-55`）。
3. 外链（含腾讯 `getPublicUrl`、微信头像）：`degraded:true`；中期把腾讯上传改为存 `bucket/path` 而非绝对 URL，使其重新进入转换链。
4. 公开桶补衍生图：`/api/public/media/sku/$` 增加 `?w=` 白名单档位（480/1080），仅允许既有两桶。
5. 覆盖面：products、products/$id、orders、orders/$id、shops、taxonomy(logo)、content(cover)、auth(avatar)。

## 5. 可机器验证的防回归规则

- 契约测试：上述每个接口的响应 schema 断言**不存在**裸 `image_url`/`cover_url`/`logo_url`/`avatar_url` 字符串字段（或存在时等于 `thumbnail_url`）。
- 尺寸断言：`thumbnail_url` 必含 `width=480`（或代理 `w=480`）；`preview_url` 含 1080；`original_url` 不含 width 参数。
- 回退断言：注入 thumbnailSigner 抛错 → 断言结果 `degraded===true` 且返回值 `!== original`；`upload/original` 调用次数为 0。
- 静态规则：ESLint/脚本禁止在 `src/routes/api/public/storefront/**` 直接引用 `signSkuImagePaths`（只能经 `buildMediaImage`）。
- 部署对照：脚本对线上 `GET /products?page_size=3`、`/products/{id}`、`/orders` 抓字段名集合，缺 `image_previews`/`thumbnail_url` 即失败，用于识别“腾讯落后于仓库”。

## 6. 本轮结论

无代码变更、无数据库变更、无部署；未输出任何签名 URL、令牌或客户数据。
