# 封面签名 502/500 与 listShopSkus 吞错 · 只读诊断

只读执行。**没有任何写操作**：未修改代码、数据库、权限、调度器，未发布，未发起有赞同步。

## 1. 签名调用量：448 个并行 POST，异常静默变 null

### 调用量推导

- `src/hooks/use-sku-covers.ts:16-22`：前端把整页 SKU id 一次性去重排序后传入，无分片。
- `src/lib/sku-covers.functions.ts:17`：入参上限 `max(500)`，448 个全部通过。
- `src/lib/sku-covers.functions.ts:31-36`：`Promise.all((rows ?? []).map(async (r) => …))` —— **对每一行 SKU 各调一次 `signSkuCover`，无并发上限、无去重**。
- `src/lib/sku-image-resolver.server.ts:68`：`signSkuCover` 只取首图，调用 `signSkuImagePaths([imagePaths[0]])`，即**每次只传 1 个路径**。
- `src/lib/sku-image-resolver.server.ts:45-50`：`signSkuImagePaths` 按桶分组后对每桶发一次 `createSignedUrls`。由于上一步每次只有 1 个路径，批量能力完全失效 → **1 个 SKU = 1 次 `POST /storage/v1/object/sign`**。

结论：448 个标准 SKU → **448 个几乎同时发出的签名请求**，而实际只有约 14 张不同的私桶图片，**约 434 次是纯重复**。这与 nginx 近 5000 条日志里 24×502 + 4×500 的形态吻合：瞬时并发压垮上游，少量请求被网关截断。

### 异常如何变成 null（三处静默点）

| 位置 | 行为 |
|---|---|
| `sku-image-resolver.server.ts:51` | `if (error || !data) return;` —— 签名失败直接 return，该批次所有槽位保持 `null`，**不抛错、不记日志** |
| `sku-image-resolver.server.ts:24` | `out` 预填 `null`，任何未被覆盖的槽位天然是 `null` |
| `sku-image-resolver.server.ts:69-78` | 首图签不出来时回退 `fallbackImageUrl`；标准 SKU 若 `image_url` 为空（本库 528 行中 461 行为空），回退也拿不到东西 → 最终 `null` |

所以 502/500 不会冒泡成错误，只会表现为"部分封面为 null"——和你观察到的现象一致。同一会话另一门店 449 SKU 通过、448 门店部分 null，正是并发抖动而非权限问题。

## 2. 现成可复用的按桶去重批量 helper

**有，且就在同一文件里**：`signSkuThumbnailPaths`（`src/lib/sku-image-resolver.server.ts:89-131`）已经实现了完整模式：

- 第 99-110 行：`unique` Map 以完整 `bucket/path` 字符串为键做**路径级去重**，同一张图的多个下标记在 `idxs` 里；
- 第 111-128 行：固定大小 worker 池，`THUMBNAIL_CONCURRENCY = 4`（第 82 行），`cursor` 递增取任务；
- 第 121 行：一次签名结果回填到所有相同路径的下标。

`signSkuImagePaths`（第 22-60 行）则已有**按桶批量**能力（第 47-50 行 `createSignedUrls` 一次传整桶路径数组），只是被 `signSkuCover` 每次传 1 个路径的用法废掉了。

### 最小复用方案（不新增权限、不改优先级、不改 TTL）

在 `signSkuCovers`（`src/lib/sku-covers.functions.ts:31-36`）把"逐 SKU 串行签名"换成"一次批量签名"：

1. 先按现有优先级规则算出每个 SKU 的**候选首图**：`image_paths[0]`，取不到则留空（优先级、`image_url` 回退规则完全不变）。
2. 把这批候选路径**去重**后组成一个数组，**只调一次** `signSkuImagePaths(uniquePaths)` —— 它内部按桶一次 `createSignedUrls`，448 个请求塌缩成**每桶 1 个**。TTL 仍是文件第 18 行的 `SIGNED_TTL = 24h`，不动。
3. 按路径把签名结果回填到各 SKU；签不出来的再走原有 `image_url` 回退逻辑（http 外链、`data:` 原样返回的行为保持不变，见第 31-34 行）。
4. 若担心单次路径数过多导致 URL/请求体过大，参照 `signSkuThumbnailPaths` 的做法加一个批大小（如每批 200 路径）+ 并发 4 的 worker 池，而不是无上界并行。

这样改只动 `sku-covers.functions.ts` 的组装方式，`sku-image-resolver.server.ts` 可以完全不改（如需可观测性，再在第 51 行加一行 `console.warn(bucket, error.message)`，不改变返回契约）。

### 建议顺带加的可观测性（不改契约）

第 51 行现在完全静默。建议记录桶名、失败路径数、错误码，让下次 502 能在服务端日志直接看到，而不是靠 nginx 日志反推。

## 3. `listShopSkus` 里被吞掉的读错误与最小显式传播方案

文件 `src/lib/shop-products.functions.ts`（本仓库当前版本；腾讯侧已含 414 分批修复，吞错点相同）：

| 行号 | 查询 | 现状 |
|---|---|---|
| **76-79** | `inv_locations` + `youzan_shops` 并行读 | **两个 `error` 都没有解构**，只取了 `data` |
| **81** | `if (!loc) return { rows: [], location_id: null, … }` | **这就是你说的 401 变空列表的确切位置**：`inv_locations` 读 401 时 `loc` 为 null，函数原样返回空 rows 且 HTTP 200 |
| 84-88 | `inv_stocks` | ✅ 已检查 `stErr` 并抛错 |
| **91-94** | `sku_youzan_links` | **error 未解构**，失败时 `links` 为 null → `?? []` → 该来源的 SKU 静默丢失 |
| **97-101** | `inv_stock_movements` | **error 未解构**，同上静默丢失 |
| 106-115 | 全局标准商品 | ✅ 已检查 `standardErr` |
| 139-140 | 主查询 `inv_skus` | ✅ 已检查 `error` |

**危害分级**：76/81 行导致整页 0 件（你已复现）；91/97 行更隐蔽——不会报错，只会让列表**少几个 SKU**，肉眼很难发现，正是这次三家店对照能通过、换账号就出问题的那类问题。

### 最小显式错误传播方案

1. 第 76-79 行改成同时解构 error：`const [{ data: loc, error: locErr }, { data: shop, error: shopErr }] = await Promise.all([...])`，随后 `if (locErr) throw new Error(locErr.message)`、`if (shopErr) throw new Error(shopErr.message)`。
2. 第 81 行的 `!loc` 分支**只保留"确实没有映射库位"这一种语义**——错误已在上一步抛出，此时返回空列表是真实业务状态。
3. 第 91-94、97-101 行各加 `error` 解构与抛错，与第 88 行 `stErr` 的写法保持一致。
4. 不改返回结构 `{ rows, location_id, store_format }`，不改门店作用域集合，不加权限，不引入新查询。

改完后，401 会以明确错误呈现在页面上（而不是"0 件"），你排查 401 根因时也能直接看到是哪张表被拒——**401 的具体原因由你诊断，本轮不做任何猜测**。

## 4. 未改动声明

本轮全部为只读读取（`src/lib/sku-covers.functions.ts`、`src/lib/sku-image-resolver.server.ts`、`src/lib/shop-products.functions.ts`、`src/hooks/use-sku-covers.ts`）。未修改代码、数据库、权限或配置，未发布，未触发有赞同步或任何写操作。
