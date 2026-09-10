# /shop-mgmt/products 显示 0 件（414 Request-URI Too Large）· 只读核对与修复建议

只读核对，未编辑任何文件、未改数据库、未发布、未触碰腾讯生产。

## 1. 现状核对

- 当前提交：`e0434d397042e53713f71dd975cd91d26b9743b2`；该函数最后一次改动提交 `6f37a03`。
- 文件：`src/lib/shop-products.functions.ts`，`listShopSkus` 第 130-139 行确认与你描述一致：

```
sb.from("inv_skus").select("*").in("id", skuIds).order("created_at", { ascending: false })
```

`skuIds` 来自 `resolveShopVisibleSkuIds`（`src/lib/shop-standard-catalog.ts:34`），Vintage 门店会并入**全部全局标准商品**。

- 规模实测（只读查询 `inv_skus`）：符合全局标准商品条件（`kind=single`、`is_custom_price=false`、`inventory_policy=unlimited`、`is_display=true`、`status=active`）的有 **448 条**，SKU 总数 528。448 个 UUID 拼进 `in.(...)` 查询串约 17 KB，加上门店自有 SKU 会更长，超出 Kong/nginx 默认请求行上限 → 内部 414。
- 为什么外层仍 200：第 139-140 行只在 `error` 非空时抛错。PostgREST 返回的 414 是 HTML 响应体，supabase-js 解析后往往给出 `data: []` 而 `error` 为空（或错误未被识别），于是 `rows` 为空数组，`patched` 为空，serverFn 正常返回 200 + 0 行。**这是静默数据丢失，不只是显示问题。**
- 同文件同类隐患（本次不在修复范围但建议一并加固）：第 91-101 行 `sku_youzan_links` / `inv_stock_movements` 查询用 `.limit(5000)`，返回条数大时后续 `skuIds` 更长；第 333 行 `listShopLinksForSkus` 的 `.in("sku_id", data.sku_ids)` 入参上限 1000，同样可能超长。

## 2. 最小修复方案（应用层有界分批，推荐）

不改数据库、不加 RPC、不动权限。把第 130-139 行的单次 `in()` 改为按固定批次并发查询后合并：

1. 新增一个纯函数 `chunkIds(ids: string[], size = 100): string[][]`，放在 `src/lib/shop-standard-catalog.ts` 或新建 `src/lib/chunk-ids.ts`，便于单测。批大小 100 时 URL 约 4 KB，安全余量足够。
2. `listShopSkus` 中对每个批次执行同样的 `select("*").in("id", batch)`，**搜索条件 `.or(name.ilike/epc.ilike/sku_code.ilike)` 必须原样加到每一个批次上**，否则会放大结果。
3. 并发上界建议 4（`for` 循环切片 + `Promise.all`），避免一次打出 5 个以上并发连接。
4. 任一批次 `error` 非空立即抛错——绝不允许再出现"部分失败静默返回空"。
5. 合并所有批次结果后，**在应用层统一按 `created_at` 降序排序**（`new Date(b.created_at) - new Date(a.created_at)`，相同时间用 `id` 兜底保证稳定），因为分批后数据库排序只在批内有效。
6. 不加任何 `limit` 截断：`skuIds` 有多少就返回多少行，`stock_qty` 映射逻辑（第 142-166 行）保持不变。

### 必须保留的语义

| 语义 | 要求 |
|---|---|
| 门店作用域 | `skuIds` 仍完全由 `resolveShopVisibleSkuIds` 决定（库存 / link / 流水 / Vintage 全局标准商品），不得改变集合 |
| 权限 | 继续用 `context.supabase`（RLS 以登录用户身份），**不得换成 `supabaseAdmin`** |
| 搜索 | `data.search` 的三字段 ilike 逐批施加，语义与现在完全一致 |
| 排序 | 最终结果 `created_at` 降序，与现在一致 |
| 条数 | 返回全部匹配行，不截断、不去重丢失、不减少 SKU |
| 返回结构 | `{ rows, location_id, store_format }` 三字段不变 |

### 备选方案（不推荐本轮做）

改成服务端 RPC 一次性按门店条件筛选（避免传 ID 列表）语义更干净，但要新增 SECURITY DEFINER 函数并重新论证权限边界，属于扩大改动面。当前没有现成合适的 RPC：`search_inv_skus` 是商城公开检索用，不带门店作用域，套用会改变可见集合。

## 3. 测试建议

1. **纯函数单测**（`src/lib/chunk-ids.test.ts`）：0 个、1 个、100 个、101 个、448 个 ID 的切分结果；批数与总数守恒，无重复无丢失。
2. **排序单测**：把两个批次的乱序结果合并后断言 `created_at` 严格降序，且时间相同时顺序稳定。
3. **回归断言**（可用现有 `shop-standard-catalog.test.ts` 的风格）：Vintage 门店 448 全局标准 + 若干门店自有 SKU 时，`resolveShopVisibleSkuIds` 输出条数与最终 `rows.length` 相等。
4. **错误传播测**：模拟其中一个批次返回 error，断言整体抛错而不是返回空数组。
5. **候选副本人工复验**：用已登录的门店账号打开 `/shop-mgmt/products`，确认条数等于该门店应见 SKU 数；搜索关键词后条数下降但不为 0；观察内部网关日志不再出现 414。
6. 可选加固：在 `listShopSkus` 里对 `rows` 为空但 `skuIds` 非空的情况打一条服务端警告日志，未来同类静默失败能第一时间被发现。

## 4. 未改动声明

未编辑源码、未运行迁移、未改数据库或调度器、未发布、未触碰腾讯生产，也未触发支付、库存写入或有赞同步。修复由你方在腾讯候选副本实现并复验。
