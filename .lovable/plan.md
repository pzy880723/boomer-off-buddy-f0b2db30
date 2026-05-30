## 问题
`/purchase/japan-parcel` 顶部 Tab 角标（全部 / 已采购 / 已签收 / 问题包裹 / 回收站）来自 `getJapanParcelCounts`，它对全表做 `count: exact`，**不带搜索词**。所以输入搜索后，列表行数变了，角标却还是全量数字，跟实际结果对不上。

## 改动

### 1. `src/lib/japan-parcel.functions.ts` — `getJapanParcelCounts`
- 增加 `search?: string` 入参（`inputValidator` 用 zod，trim、≤200）。
- 当有 search 时，复用 `listJapanParcels` 里那段搜索逻辑：
  - 先查 `japan_parcel_items` 取匹配的 `parent_id` 集合（limit 500，与 list 保持一致，避免口径不一致）；
  - 五个 `count: exact, head: true` 查询都额外 `.or(...)` 同样的 6 条件 + `id.in.(...)`。
- 无 search 时维持现在的实现，零额外开销。
- 抽一个内部小函数 `applySearch(q, search, parcelIds)` 避免重复。

### 2. `src/routes/purchase.japan-parcel.index.tsx`
- `countsQ` 的 queryKey 改成 `["jp-parcels-counts", submittedSearch]`，queryFn 传 `{ data: { search: submittedSearch || undefined } }`。
- `qc.invalidateQueries({ queryKey: ["jp-parcels-counts"] })`（写操作后的失效逻辑）保持现状即可，按前缀失效会带上所有 search 变体。
- 其它逻辑不变。

### 3. 不动
`PURCHASED_STATUSES / DELIVERED_STATUSES` 字典、Badge UI、`listJapanParcels`、移动端、数据库 schema、RLS。

## 备注
- 子商品匹配上限 500 与列表查询一致，所以"列表显示 N 条 / 角标 N"在常规体量下完全吻合；若极端搜索命中超过 500 个 parent，两侧会同时截断，行为一致。
- 5 个 count 走 `Promise.all`，加搜索后单次请求只多一次 items 查询，性能开销可接受。
