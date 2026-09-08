# 只读审计结果（本轮不改代码/数据/订单，不发布）

## 1. 真实可售集的字段覆盖（不是全部 SKU）

可售集定义：`commerce_listings.status='published'` + SKU `status='active'` 且 `is_display` + 对应门店 `inv_stocks.qty>0`（与 `commerce_listing_availability` 同口径；该函数只授权给 service_role，我用同样的库存逻辑复算）。结果 **4 条**，与 Codex 公网看到的一致。

| 字段 | 有值 / 4 |
|---|---|
| 分类 category | 4 |
| 图片 image_paths | 3 |
| 成色 condition_grade（上架层） | 3 |
| 成色 grade（SKU 层） | 3 |
| 关键词 keywords | 3 |
| 属性 attributes | 3 |
| 标签 facets（任一维度） | 3 |
| IP ip_id | 1 |
| 品牌 brand_id | 0 |
| 重量 weight_g | 0 |

可售集内各标签维度覆盖（每个维度目前都只有 1 个取值）：function 3、era 1、material 1、origin 1、release_method 1、style 1；craft / object_type / ip / character / series 在可售集内为 0。

作为对照，全部 active+可展示 SKU 共 463 条：分类 463、图片 461、备注 46、属性 37、成色 13、关键词 5、标签 4、IP 1、品牌 0。备注正文未读取，仅计数。

## 2. 尺寸/重量/产地/材质/年代/工艺 到底在哪

两套并存，这是当前最大的一致性问题：

- **只在 attributes JSON 里**（可售集 3/4 条有，键均出现 3 次）：`dimensions`（尺寸）、`colors`、`maker`、`functional_status`、`missing_parts`、`origin_region`、`origin_country`、`brand`（文本，非外键）。
- **attributes 与 facet 维度重复**：`material`、`era`、`craft`、`object_type`、`origin` 这 5 个既写进 attributes，又存在对应的 facet 维度；facet 侧数据更稀（craft/object_type 在可售集为 0）。
- **独立列**：重量 `inv_skus.weight_g`（可售集 0 条有值）、成色 `commerce_listings.condition_grade` 与 `inv_skus.grade`（两处并存）、品牌 `brand_id`（外键，全空）、IP `ip_id`。
- 可筛选性差异：facet 走 `inv_sku_facets` 有索引、能进 `search_inv_skus` 参与筛选；attributes JSON 目前没有 GIN 索引，也没有任何接口按它筛选。**尺寸、颜色、制造者、功能状态、缺件这几项现在完全无法筛选。**

结论：要做真实可用的筛选器，必须先决定 material/era/craft/object_type/origin 以 facet 为唯一真源，attributes 只留展示型字段（尺寸/颜色/缺件/功能状态）。

## 3. 字段公开边界

可对客户公开：分类、品牌、IP、facet 各维度、成色、价格、门店、尺寸/颜色/功能状态/缺件（展示用）。
内部不可公开：`epc`、`barcode`、`price_tier`、`is_custom_price`、`ai_suggested_price`、`sale_ownership`、`settlement_party_ref`、`inventory_policy`、`default_shop_ids`、`notes`、`attribute_confidence`、`clarification_requests`、`recognition_request_id`、`sku_scope`、`category_confidence`。

## 4. 筛选器契约（现状已验证部分）

`products.ts` 第 18-28 行确实把 `brand_ids`、`facet_codes` 传入 `search_inv_skus`。数据库内实际语义：品牌数组内 OR；facet 同维度内 OR、跨维度 AND（`matched_dimensions = selected_dimensions`）；`primary_category` 命中本身或子分类；三者之间 AND。缺口是 `location_id` 不进 RPC（只在 listings 层过滤），且筛选项没有计数——以当前数据，绝大多数品牌/标签点开都是 0 结果。

最小契约建议：`GET /api/public/storefront/filters?location_id&primary_category`，只统计上面第 1 节口径的可售集，返回带 count 的分类/品牌/facet 维度/成色/价格区间，count=0 不返回；语义与 RPC 保持一致。

## 5. 托管与备份（可确认值）

- Lovable Cloud 托管 Supabase，Postgres 17.6，连接池 `aws-1-ap-northeast-1`（东京），规格 Tiny，未暂停。存储桶 6 个，`parcel-item-images` 公开，其余私有。
- pg_cron 5 个任务：有赞 30 分钟同步已停用；库存推送、渠道同步、预留释放、商品图 worker 每分钟运行。
- 备份：仓库内只有 `infra/tencent-supabase/ops/backup.sh` + systemd timer，备份对象是腾讯自建实例（`/srv/boomer-data`），**不覆盖这个托管库**；没有任何针对托管库的独立导出脚本，也没有恢复演练记录。
- 未证实：托管方备份频率/保留期/跨区冗余、平台宕机或停业时的数据取出时效——无证据，不当作已备份。

## 6. 性能实测与缓存边界

- `search_inv_skus` 全量（500 上限）74ms，`shared hit=11241`，无 IO 瓶颈；但每次为全部 464 个 SKU 拼 document 做相似度，无对应表达式/trgm 索引，规模上去会线性变慢。
- 索引齐：`idx_commerce_listings_public(status,published_at)`、`idx_commerce_listings_location(location_id,status)`，`inv_skus` 有 brand/category/ip/keywords/sku_code。
- 你给的 loopback 3.23/1.86 秒说明瓶颈在应用层不是手机网络：`products.ts` → RPC → listings(≤500) → `enrichStorefrontListings` 内部 SKU/facets/可售量一批，随后**串行**再查分类、品牌、父分类三轮往返 → 才分页签图。`commerce_listing_availability` 是逐行 plpgsql 循环，每个 listing 两次子查询。
- 缓存现状：只有 taxonomy 带 `s-maxage=300`；商品列表/详情无公共缓存头。修正上轮表述：展示层（列表卡片的标题/图片/标签/参考价）可用短 TTL + stale-while-revalidate + 版本化重校验；必须实时强校验的是结算时的价格与可售库存，以及会员、支付、订单。

## 7. 地址粘贴识别（设计口径）

按你的要求改为**手机本地优先解析**：正则抽手机号/邮编，词表匹配省/市/区，剩余归详细地址，姓名取剩余短串；不把客户 PII 发到任何 AI 服务，本地解析失败就留空由人工填，不编造。

## 8. 小程序「商品」字

已由你定位在小程序 category 页 result-head，不在本仓库内，由 Codex 侧处理，本轮不动。

## 未证实事项

- 托管方备份/恢复能力（无证据）。
- 4 条可售商品的公网表现由 Codex 实测，本轮未再 curl 预览。
- 本轮未触碰测试商品与有赞同步任务。
