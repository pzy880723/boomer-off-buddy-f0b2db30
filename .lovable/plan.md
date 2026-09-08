# 公共商品列表 / 图片 / taxonomy 只读性能核查结论

HEAD：`af224b5`（本轮未改代码、未迁移、未改配置、未发布；腾讯 erp.boomeroff.com 生产未部署任何改动）。

## 一、图片签名是否 N+1 —— 是，且在分页之前对全量签名

- `src/server/storefront-products.server.ts:142`：`enrichStorefrontListings` 对每个 listing 调 `resolveStorefrontListingImages`，每次内部调 `signSkuImagePaths` → `createSignedUrls`（`src/lib/sku-image-resolver.server.ts:45-56`）。每个 listing 各自发一次 Storage 签名请求（并发，但请求数 = listing 数）。
- `src/routes/api/public/storefront/products.ts:66-72`：先对最多 500 条 listing 全部富化（含签名），再 `filter(stock>0)`、再 `slice` 分页。图片签名和 facets/brand 查询都发生在切页之前。
- 只读计时（沙箱 → 嵌入存储）：跨 listing 桶级一次 `createSignedUrls(8 paths)` 299ms；逐条 10 次串行 2408ms。可以按请求把所有 listing 的 path 合并后，按桶各调一次（`signSkuImagePaths` 本身已支持多路径按桶分组，只是调用方逐条喂）。

## 二、嵌入存储是否支持签名图片变换 —— 支持（只读实测）

对一张已发布 listing 首图（`sku-listing` 桶 PNG）用 service role 生成 60 秒签名 URL 并 GET（未输出 URL/secret）：

| 请求 | 状态 | 类型 | 字节 |
|---|---|---|---|
| 原图签名 | 200 | image/png | 1,261,449 |
| `transform:{width:480,resize:contain,quality:75}` 签名 | 200 | image/png | 279,013 |

- 原图未改、桶未公开；变换只发生在读取侧。响应 `cache-control` 为空（对象上传时未设 cacheControl；`storage.objects` 元数据统计：sku-listing 44 个对象、25 个 >1MB、24 个 PNG、7 个 no-cache；sku-raw 26 个对象、26 个 no-cache、最大 2.0MB）。
- 注意：变换保留 PNG 格式（未自动转 webp，需客户端 `Accept: image/webp` 或 `format` 选项再验证）；480px PNG 仍约 279KB，若要更小需上传侧生成 JPEG/WebP 副本（属后续实施项）。

## 三、列表与 taxonomy 的串行查库

`GET /api/public/storefront/products` 实际链路（只读计时）：
1. `search_inv_skus(limit 500)` — 898ms，返回 500 个 SKU（`products.ts:17-27`；按 SKU 搜索，而当前 published listing 只有 4 条）。
2. `commerce_listings … in(500 sku_ids)` — 421ms（`products.ts:45-54`）。
3. 逐 listing 签名（第一节）。
4. 并行：`inv_skus` / `inv_sku_facets` / `commerce_listing_availability`（758ms）（`storefront-products.server.ts:146-161`）。
5. 再串行：categories+brands（171-184 行）→ 再串行 parent categories（197-202 行）。

共 5 段串行 RTT + 逐条签名，与本机 1.4–2.4s TTFB 吻合。

`GET /api/public/storefront/taxonomy`（`taxonomy.ts:13-33`）：三张表并行各 ~270-290ms（96 类 / 187 品牌 / 23 facet），单次 RTT 约 0.3s + 边缘冷启动，与 ~0.9s 吻合；主要开销是每次请求都重取全量品牌（含 aliases）。

## 四、public 缓存边界（当前状态 + 安全边界）

当前：`storefrontJson`（`src/server/storefront-auth.server.ts:11-20`）不设任何 `Cache-Control`；products / taxonomy 响应都无缓存头。`/api/public/media/sku/$`（`src/routes/api/public/media/sku/$.ts:32`）已是 `public, max-age=86400, immutable` 的代理，但它每次在服务端下载整张原图再转发，且无尺寸参数。

可安全缓存（内容不含实时价格/库存/身份）：
- taxonomy：`public, s-maxage=300, stale-while-revalidate=600`。
- 图片字节（缩略图代理或签名 URL 目标）：长 TTL，路径即内容键。

不得缓存/必须 `no-store`：
- products 列表与详情中的 `price / compare_at_price / available_qty / stock`（`storefront-products.server.ts:128-134`）、`commerce_listing_availability` 结果；orders / payments / membership / shortages / support 全部路由。若要缓存列表，只能缓存"去价格库存的静态快照"，价格库存由客户端另请求实时接口，或响应明确标注 `snapshot_at` 且不得当成实时。

## 五、后续实施项（本轮均未实施）

1. `products.ts`：先按 published listing 分页，再签名当前页；`enrichStorefrontListings` 改为收集本页全部 `image_paths` 一次调用 `signSkuImagePaths`（桶级批量）。
2. 列表封面使用 `createSignedUrls(..., { transform: { width: 480 } })` 或让 `/api/public/media/sku/$` 接受 `w=` 并走 Storage render 端点，保持原图不动、桶不公开；补 `Cache-Control`。
3. `search_inv_skus` 改为限定在 published listing 的 SKU 内或增加 listing 侧索引，避免 500 行无效搜索；categories/parent 合并为一次查询。
4. taxonomy 加 `s-maxage`；storefrontJson 默认 `no-store`，仅白名单路由覆盖为 public。
5. 上传侧为 sku-listing 设置 `cacheControl` 并生成 JPEG/WebP 列表副本。
6. 补测试：`storefront-products.test.ts` 增加"N 个 listing 只触发 1 次/桶签名"和"分页 total 与本页签名数一致"的断言。

## 六、证据与边界

- 只读 SQL：`commerce_listings` published 4 条 / sold 1 条；storage 对象大小统计如上。
- 只读探测脚本在 /tmp 运行后已删除；未打印签名 URL、token 或密钥。
- 现有测试 `src/server/storefront-products.test.ts` 未覆盖签名调用次数。
- 未修改任何文件（除本计划）、未迁移、未发布，腾讯生产保持原版本。
