## 现象与根因

用户在「门店管理 → 门店商品」里新建商品后，商品不出现在列表里。

数据库里查证：
- 最近 2 个新建的门店 SKU（`test`、`测试商品`）在 `inv_skus` 里成功写入了，但 `inv_stock_movements` / `inv_stocks` / `sku_youzan_links` 三张表里对这两个 SKU **一行数据都没有**。
- 上一轮加的 `shop_new_sku` / `shop_adjust` `ref_type` 约束修复是在 17:22 才应用。这两个 SKU 是 17:03 和 17:21 创建的，都在修复之前 —— 当时 `inv_apply_movement` 因为 CHECK 约束失败抛错，`registerNewSkuAtShop` 中断，SKU 却已经落库了，就成了孤立商品。
- 而 `listShopSkus` 只显示「本门店库存 > 0」或「本门店有 sku_youzan_link」的 SKU，孤立商品哪一条都不满足，所以列表看不到。

约束现在已经放宽了，新建流程本身通了，但：
1. 这两个孤立 SKU 永远不会自己冒出来。
2. 以后如果 `registerNewSkuAtShop` 的下游（比如 `ensureBranchListing` 调有赞 API）再抛错，SKU 又会重新变孤立。

## 修复方案

### 1. 回填历史脏数据
对 `8ef769b3…（test）` 和 `70a6d177…（测试商品）`，在当前分店（`中信泰富店`，location `7111b585…`）走一次 `inv_apply_movement`，`+1` 库存、`ref_type='shop_new_sku'`、`note='脏数据回填：约束修复前遗留'`。执行后列表里就会看到它们。

如果用户不需要这两个测试 SKU，改成删除也可以 —— 需要先确认。

### 2. 让 `registerNewSkuAtShop` 更健壮
`src/lib/shop-products.functions.ts`：
- 每个 sku 的 `inv_apply_movement` + `ensureBranchListing` 独立 try/catch，任意一步失败都记到本条结果的 `error` 字段里，继续处理下一个 sku（不再整体抛错）。
- 返回结构里明确 `stock_ok` / `listing_ok` / `error`，前端可以针对性提示「商品已创建，但入库/上架失败，可点重试」。
- 加一条兜底：即便 `inv_apply_movement` 失败，也 upsert 一行 `inv_stocks (sku_id, location_id, qty=0)`，这样 SKU 至少会出现在列表里（当作「库存 0」显示），用户能看到并手动补库存，不会再"人间蒸发"。

### 3. 让 `listShopSkus` 收网
`src/lib/shop-products.functions.ts` 里 `listShopSkus` 目前的并集是「stock > 0 ∪ 有 link」。改成：
- 「本门店 `inv_stocks` 里有记录（即便 qty=0）∪ 本门店有 sku_youzan_link ∪ 本门店有过 `inv_stock_movements`」。

这样只要该门店曾经动过这个 SKU（哪怕只是失败前的一行 movements 或一行 qty=0 的 stock），列表里都能看到，配合前端 badge 显示「库存 0，点击补货」。

### 4. 前端 toast 语义微调
`src/routes/shop-mgmt.products.tsx` 的 `handleNewSkuCreated`：
- 遍历 `results`，分别统计「入库失败 / 上架失败 / 全成功」的条数，逐类给出 toast，避免出现「明明报了成功但列表是空的」的困惑。

## 需要确认

- 两个测试 SKU（`test` / `测试商品`）是「保留并回填库存 +1」还是「直接删除」？
