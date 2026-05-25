## 目标
1. 日本小包列表的搜索框支持按"商品名称"搜索，覆盖中文（`item_title_cn`）和日文（`item_title`），既包含包裹主表的标题，也包含子商品 `japan_parcel_items` 里的标题。
2. 一旦搜索框有内容，列表自动切到「商品」展示模式（`ViewModeToggle` 的 item 视图），方便直接看到匹配到的商品。清空搜索后保留用户原本选择的模式。

## 变更范围

### 1. `src/lib/japan-parcel.functions.ts` — `listJapanParcels`
扩展搜索逻辑，让 keyword 同时命中子商品标题：

- 在现有 `data.search` 分支中：
  - 包裹主表 OR 条件追加 `item_title_cn.ilike.%s%`（目前只匹配日文 `item_title`）。
  - 先用一条额外查询查 `japan_parcel_items`：`select parcel_id` where `item_title ilike s OR item_title_cn ilike s`，去重得到 `matchedParcelIds`。
  - 把上面这组 id 合并到主查询的 `.or(...)`：通过 `id.in.(uuid1,uuid2,...)` 子句加入，与现有 5 个字段一起 OR。
  - 空集时跳过 `id.in.(...)`，避免 PostgREST 语法错。
- 其他逻辑（tab、排序、limit）不变；search 仍保留对订单号、物流号、卖家、收件人的匹配。
- 中文走 `ilike` 已能匹配（Postgres ilike 对 Unicode 大小写不敏感对中文等价于普通匹配），无需额外配置。

### 2. `src/routes/purchase.japan-parcel.index.tsx` — 搜索时自动切换商品视图
- 引入可写版本：`const [viewMode, setViewMode] = useParcelViewMode();`
- 增加一个 `useEffect`：当 `debouncedSearch` 非空且 `viewMode !== "item"` 时，调用 `setViewMode("item")`。
- 不在清空搜索时自动改回，避免来回跳；用户可手动点 ViewModeToggle 切回包裹模式。
- 搜索框 placeholder 更新为「搜索订单号 / 物流号 / 商品名称（支持中文）」，让能力可见。

不动：`ViewModeToggle`、`useParcelViewMode`、商品视图的渲染（已经存在的 item 行）、PC 之外的页面、计数接口、其它路由。

## 技术细节

- PostgREST `.or()` 中 `id.in.(...)` 的值用逗号分隔的 UUID，不带引号；UUID 形如 `xxxxxxxx-xxxx-...`，安全字符集，不需要再转义。
- 额外那条 `japan_parcel_items` 查询限制 `limit(500)` 防止极端情况下结果过大；若超出，主搜索仍能通过包裹标题命中，可接受。
- `useEffect` 依赖 `[debouncedSearch]`，避免每次渲染都 setState。

## 不做
- 不做高亮匹配项。
- 不调整 item 视图的列结构、排序。
- 不修改移动端 `/m/parcels`（如需后续可加）。
