## 目标

让手机端 `/m/parcels` 也支持「包裹 / 商品」两种维度切换，商品维度可以看到单件价格，并支持按商品名搜索。

## 改动范围

### 1. `src/lib/mobile.functions.ts`
- 扩展 `searchParcels` 入参：新增 `mode: "parcel" | "item"`，默认 `parcel`，保持现有行为不变。
- 当 `mode === "item"` 时改查 `japan_parcel_items`：
  - 选择字段：`id, parent_id, item_title, item_title_cn, item_image_url, unit_price_jpy, quantity, item_total_jpy, item_total_cny, pay_at, japan_parcels!inner(id, source_order_no, tracking_no, status, received_at, is_problem, deleted_at, intl_pay_at)`
  - `deleted_at is null`、bucket 状态筛选作用在 `japan_parcels` 上（待签收/已签收）。
  - 搜索 `q` 走商品字段：`item_title.ilike / item_title_cn.ilike`，以及订单号 / 物流号（来自父表）。
  - 排序按 bucket：待签收用 `created_at desc`，已签收用 `japan_parcels.received_at desc`。
  - 返回扁平化的 `items` 数组，包含：`id, parcel_id, source_order_no, tracking_no, status, is_problem, received_at, item_title(_cn), item_image_url, unit_price_jpy, quantity, item_total_cny`。

### 2. `src/routes/m.parcels.tsx`
- 复用已有的 `useParcelViewMode` hook（和 PC 端同源），在搜索框下方加一行 segmented 控件：「包裹 / 商品」，沿用 `ViewModeToggle` 风格但适配移动端尺寸（更高更易点）。
- `useQuery` key/参数带上 `mode`；queryFn 透传 `mode`。
- 当 `mode === "item"` 时渲染商品列表：
  - 卡片显示商品缩略图、商品名（中文优先）、`¥单价` 大字 + `×数量 = ¥小计` 灰字、订单号、状态/签收时间、问题标记。
  - 点击跳到 `/m/receive/$id`（父包裹详情）。
- 当 `mode === "parcel"` 时保持现有 UI 不变。
- 空态文案根据 mode 区分（「没有匹配的商品」/「没有匹配的包裹」）。
- 与 PC 端一致：用户输入搜索词时自动切到「商品」视图，便于直接看到匹配商品。

### 3. 不改的部分
- `m.receive.$id`、PC 端列表、`use-parcel-view-mode` 全局状态保持不变（手机端切换会和 PC 端同步到 localStorage，这是预期行为）。
- 状态枚举、bucket 定义不变。

## 验证

- 手机端 `/m/parcels` 切到「商品」后能看到每件商品独立一行，含单价 ¥ 显示。
- 搜索「ガンプラ」之类关键词在商品维度能命中商品；在包裹维度仍按包裹返回。
- 待签收 / 已签收 tab 在两种维度下都正确过滤。
- 点击商品行进入对应包裹详情。
