# 只读审计结果 + 下一步最小方案

本轮只做审计与设计，没有改任何代码、数据、订单，也没有发布。

## 1. 上架字段 → 数据库字段映射与真实覆盖率

商品主档在 `inv_skus`（44 列），上架记录在 `commerce_listings`，标签在 `inv_sku_facets` + `inv_facets`，品牌 `inv_brands`，分类 `inv_categories`。

可对客户公开筛选的字段：分类 `inv_skus.category`、品牌 `brand_id`、IP `ip_id`、标签维度（object_type/function/origin/material/era/craft/style/ip/character/series/release_method）、成色 `commerce_listings.condition_grade`、价格 `price`、门店 `location_id`。
内部不可公开：`epc`、`barcode`、`price_tier`、`is_custom_price`、`ai_suggested_price`、`sale_ownership`、`settlement_party_ref`、`inventory_policy`、`default_shop_ids`、`notes`、`attribute_confidence`、`clarification_requests`、`recognition_request_id`、`sku_scope`。

实测覆盖（`status='active' AND is_display`，共 463 条；不含任何客户数据）：

| 字段 | 有值条数 |
|---|---|
| 分类 category | 463 |
| 图片 image_paths | 461 |
| 备注 notes | 46 |
| 属性 attributes | 37 |
| 成色 grade | 13 |
| 关键词 keywords | 5 |
| 标签 facets | 4 |
| IP ip_id | 1 |
| 品牌 brand_id | 0 |
| classification_status 已确认 | 0 |

标签按维度只有 function 5、style 3、material 3、object_type 2、origin/release_method/era 各 1。

关键事实：当前 `commerce_listings` 里 `status='published'` 只有 5 条，其中 SKU 同时 active+可展示的只有 4 条；`inv_skus.stock_qty` 全部为 0/空，真实可售量来自 `commerce_listing_availability` RPC（基于 `inv_stocks`），所以"在售"判断绝不能改用 stock_qty。

结论：品牌/标签筛选器在结构上已经具备，但数据几乎是空的。筛选器必须按"当前在售商品实际存在的取值"动态生成，否则会出现一堆点了返回 0 结果的选项。

## 2. 托管、依赖与备份（可确认部分）

- 数据库/存储/认证：Lovable Cloud 托管的 Supabase 实例，Postgres 17.6，连接池主机 `aws-1-ap-northeast-1`（东京 ap-northeast-1），规格 Tiny，未暂停。
- 存储桶 6 个：`parcel-item-images` 公开，其余 `domestic-order-screenshots`/`domestic-bulk-attachments`/`sku-raw`/`sku-listing`/`shop-images` 私有。认证用户 4 个。
- 定时任务 5 个（pg_cron）：有赞 30 分钟同步已停用；库存推送、渠道同步、预留释放、商品图 worker 均每分钟运行中。
- 备份证据：仓库里只有 `infra/tencent-supabase/ops/backup.sh` + systemd timer，它备份的是腾讯自建实例（`/srv/boomer-data`），**不是**这个 Lovable 托管库。仓库里没有针对托管库的独立导出脚本，也没有任何恢复演练记录。
- 未证实：托管方的备份频率与保留期、跨区冗余、以及"Lovable 停业/宕机"下的数据取出时效——这些平台侧承诺我无法用证据核实，不当作已备份。

风险落地建议（待批准后实施）：新增一个只读定期导出（业务表 + 存储清单）到你自己掌握的存储，并做一次真实恢复演练；这需要单独授权。

## 3. 加载慢的实测链路

- `search_inv_skus` 全量调用（500 上限）实测 74ms，`shared hit=11241`，没有 IO 瓶颈；它每次都要为全部 464 个 SKU 拼接 document 文本做相似度，规模变大后会线性变慢，且没有针对该文档的表达式/trgm 索引。
- 索引现状良好：`idx_commerce_listings_public(status, published_at)`、`idx_commerce_listings_location(location_id,status)`、`inv_skus` 上 brand/category/ip/keywords/sku_code 均有索引。
- 真正的耗时在接口层：`products.ts` 先 RPC 取候选 → 再查 listings（上限 500）→ `enrichStorefrontListings` 里串行做 SKU/facets/可售量 → 再串行查分类、品牌、父分类（3 轮往返）→ 才分页签图。签图已按桶批量+当前页，缩略图 480px 并发 4。
- 缓存：只有 taxonomy 有 `s-maxage=300`；商品列表/详情无公共缓存（正确，价格库存不能缓存）。

最小提速方向（待批准）：把分类/品牌/父分类三轮串行往返合并为并行 + 内存短缓存（分类品牌本就可缓存）；候选 SKU 先按门店与在售过滤再富化。

## 4. 筛选器最小契约

`GET /api/public/storefront/products` 已经真实把 `brand_ids`、`facet_codes` 传进 `search_inv_skus`（products.ts 第 18-28 行，storefront-products.server.ts 第 176-177 行）。数据库里的实际语义：

- `brand_ids`：数组内 OR（`s.brand_id = ANY(...)`），空数组不过滤。
- `facet_codes`：同一维度内 OR、跨维度 AND（`matched_dimensions = selected_dimensions`）。
- `primary_category`：命中本身或其子分类。
- 三者之间 AND。

缺口：`location_id` 只在 listings 层过滤，没进 RPC；筛选项没有计数，客户会看到空结果选项。

建议新增只读接口 `GET /api/public/storefront/filters`，参数 `location_id`、`primary_category`，返回：

```text
{ primary_categories:[{code,name,count}],
  brands:[{id,name,count}],
  facets:[{dimension,items:[{code,name,count}]}],
  price_range:{min,max},
  condition_grades:[{code,count}] }
```

只统计"当前 published + 可售量>0 + SKU active/可展示"的商品，count=0 的取值不返回。语义与上面 RPC 保持一致（维度内 OR、维度间 AND）。

## 5. 地址粘贴智能识别（设计）

沿用现有识别管线写法（`src/lib/recognize.functions.ts` 的 serverFn 模式），新增一个纯文本 → 结构化的 serverFn：输入一段粘贴文本，输出收件人、手机号、省/市/区、详细地址、邮编，先用正则抽手机号/邮编/省市区，剩余归详细地址，识别不出的字段返回空不编造，前端逐字段可改。不落库、不返回任何已有客户数据。

## 6. 列表左上「商品」字

ERP 仓库内命中的候选是移动端外壳标题（`src/routes/m.skus.index.tsx` 的 "商品 SKU"、`src/components/mobile/mobile-shell.tsx` 底部导航 "商品"）。你说的"列表左上"如果是微信小程序商城页面，那不在本仓库内（由 Codex 那边改）。需要你确认是哪一个界面，我再定位删除。

## 待你确认

1. 「商品」字具体是哪一屏（ERP 手机端 / 小程序）。
2. 是否要我按第 4 节实施 filters 接口 + 前端动态筛选器。
3. 是否授权做独立备份导出与恢复演练（涉及新增脚本与外部存储）。
