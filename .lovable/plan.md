# 修复：搜索"史努比"后跳出大量无关商品

## 根因

后端 `listJapanParcels` 搜索时：通过子商品表先查到匹配的 `parent_id`，再把这些**整个包裹**（含全部子商品）返回。前端商品视图（`viewMode === "item"`）会把每个包裹的 `japan_parcel_items` **全部展平**渲染。

举例：搜"史努比"匹配到包裹 `CN111077666JP` 里 1 个史努比相关商品 → 该包裹的全部 ~30 个商品（领带、纽扣、台钟、麦当劳…）都被显示出来，所以看上去"全是无关内容"。

## 改造方案

只改前端 `src/routes/purchase.japan-parcel.index.tsx` 的商品视图渲染逻辑，**不动**后端、不动包裹视图：

1. 把 `submittedSearch` 传进商品视图的 flatMap 分支。
2. 当 `submittedSearch` 非空 且 `viewMode === "item"` 时，对每个包裹的 `sortedItems` 做一次本地过滤：
   - 取关键词 `kw = submittedSearch.trim().toLowerCase()`
   - 命中条件：`item_title` 或 `item_title_cn` 的 lowercase 包含 `kw`
   - 过滤后非空 → 只渲染命中的子商品行
   - 过滤后为空 → 说明这个包裹是通过订单号 / 运单号 / 卖家 / 收件人等父级字段匹配的，**回退**渲染原全部商品（保持现在能定位到包裹的体验），不让它变成空行
3. `landedMap` 仍然基于完整 `sortedItems` 计算（因为分摊国际运费要按整包），过滤只影响展示。

## 不改动

- 后端 `listJapanParcels`（仍按"匹配到子商品 → 拉整包"返回，保证统计/landed 计算正确）。
- 包裹视图、搜索按钮、清除按钮、跨 tab 搜索、PostgREST 转义等已修复逻辑。
- 子商品弹窗、`ItemsHoverPreview` 等。

## 验证

- 搜"史努比" → 商品视图只剩标题含"史努比 / Snoopy"的行。
- 搜运单号 `CN111077666JP` → 商品视图仍显示该包裹全部商品（回退分支生效）。
- 搜中文关键字大小写、英文关键字混合 → 都按 lowercase 包含判定。
