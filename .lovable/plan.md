## 背景

数据库实情：待签收 1 个包裹 / 4 件商品；已签收 120 个包裹 / 467 件商品。所以「待签收」Tab 默认只有 1 行不是 bug；但当前默认是「包裹维度」，右侧只显示 `grand_total_cny`，所以看不到「单件平均成本」。

## 改动

### 1. `src/hooks/use-parcel-view-mode.ts`
- 默认值由 `"parcel"` 改为 `"item"`（首次进入即按商品维度展示，自然能看到单件均价）。

### 2. `src/lib/mobile.functions.ts` — `searchParcels`
- 入参新增 `offset: z.number().min(0).default(0)`，`limit` 上限保持 50。
- 两条分支（parcel / item）都加 `.range(offset, offset + limit - 1)` 实现分页。
- 返回值新增 `hasMore: rows.length === limit`，供前端判断是否还要继续拉。
- 包裹维度的 select 顺手补 `item_total_cny`（用来算包裹行的均价），把每个 child 的 `item_total_cny` 累加到 `items_total_cny`；若 `grand_total_cny` 为空则回退使用 `items_total_cny`。返回里加 `avg_unit_cny = (grand_total_cny ?? items_total_cny) / Σqty`（拿不到就 null）。注意：均价是按"件数总和 Σqty"算，而不是商品行数 `item_count`，避免一件商品 qty>1 时被低估。

### 3. `src/routes/m.parcels.tsx`
- **分页**：用 `useInfiniteQuery` 替换 `useQuery`，`getNextPageParam` 根据 `hasMore` 返回累计 offset；`pageParam` 初始 0，步长 30。
- **无限滚动**：底部放一个 `<div ref={sentinelRef} />`，用 `IntersectionObserver` 监听，进入视口且 `hasNextPage && !isFetchingNextPage` 时调用 `fetchNextPage()`。展开渲染时把 `data.pages.flatMap(p => p.items / p.rows)` 拼起来。
- **包裹维度行**：右下补一行 `¥{avg_unit_cny.toFixed(2)} × N 件`（N = Σqty，若无 qty 退回 item_count）。如果 `avg_unit_cny` 为 null，则只显示 `N 件`，不画均价。
- 底部 sentinel 下方根据状态显示 `加载中…` / `没有更多了` 文案；初次加载用现有 skeleton 占位（如缺则补一个简单的）。
- 搜索文本变化、bucket 切换、mode 切换都要重置分页 (`queryKey` 已含这些字段，React Query 会自动重置)。

### 4. 验证
- 进入 /m/parcels → 默认看到 467 件已签收商品中的前 30 件（商品维度，待签收只 4 件）；每行右侧有 `¥xx.xx × N 件`。
- 切到「包裹」维度 → 每行右下既有总价又有均价。
- 滚到底部 → 自动加载下一页直至 `hasMore=false`。
- 输入搜索词 → 自动切商品维度（已有逻辑），分页同样生效。

## 不动的地方

- 默认 Tab 维持「待签收」。
- localStorage 维度记忆逻辑保留（用户手动切过仍记住），仅改"未设置"时的默认值。
- 商品详情 Sheet、签收跳转等行为不变。
