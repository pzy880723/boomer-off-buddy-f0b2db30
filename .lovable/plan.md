## 仪表盘重构 + 国内渠道改名 + 物流追踪移除

### 1. 数据源接入（替换 mock）

新建 `src/lib/dashboard.functions.ts`，一个 serverFn `getPurchaseStats()`，用 supabaseAdmin 聚合：

- **日本小包裹**：`japan_parcels`（未删除），金额取 `coalesce(grand_total_cny, total_cny, 0)`，日期取 `coalesce(purchased_at, created_at)`。
- **日本大宗**：当前没有真实表，先用 `0` 占位 + "待接入"角标（后续接表只改 serverFn）。
- **国内小包**：`domestic_orders`（未删除），金额取 `coalesce(total_cny, 0)`，日期取 `coalesce(purchased_at, created_at)`。

返回结构：
```ts
{
  totals: { month: number, ytd: number, all: number },   // 三类合计
  byChannel: [
    { key: 'japan_parcel', label: '日本小包裹', month, ytd, all, count },
    { key: 'japan_bulk',   label: '日本大宗',   month, ytd, all, count, placeholder: true },
    { key: 'domestic',     label: '国内小包',   month, ytd, all, count },
  ],
  monthlyTrend: [{ month: '2025-12', japan_parcel, japan_bulk, domestic }, ...] // 近 12 个月
}
```

时间口径用服务器侧 `now()` 计算"本月起点 / 本年度起点"。

### 2. 仪表盘页面改造 (`src/routes/dashboard.tsx`)

完全替换内容（移除所有 mock-data 引用）：

```text
┌───────────────────────────────────────────────────────────┐
│ PageHeader: 仪表盘 / 累计采购金额概览                       │
├───────────────────────────────────────────────────────────┤
│ 3 × MetricCard：本月采购 / 本年度采购 / 累计采购            │
│   prefix=¥，副标显示 总单数                                  │
├───────────────────────────────────────────────────────────┤
│ 分类目统计 (3 列 Card)                                      │
│   - 日本小包裹  本月 ¥ / 本年 ¥ / 累计 ¥ · N 单 → /purchase/japan-parcel │
│   - 日本大宗    本月 ¥ / 本年 ¥ / 累计 ¥ · N 票 → /purchase/japan-bulk   │
│   - 国内小包    本月 ¥ / 本年 ¥ / 累计 ¥ · N 单 → /purchase/domestic     │
├───────────────────────────────────────────────────────────┤
│ 近 12 个月采购趋势 (StackedBarChart, 三类目堆叠)            │
└───────────────────────────────────────────────────────────┘
```

数据用 `useQuery + useServerFn(getPurchaseStats)`，loading 骨架 + 错误兜底。删除欢迎条、目标进度、批次回本率、门店排行、物流成本图、待办、动态时间线。

### 3. 移除"物流追踪"

- 删除 `src/routes/purchase.logistics.tsx`。
- `src/components/app-sidebar.tsx`：删除 `/purchase/logistics` 菜单项 + `NavTo` 中的字符串字面量 + `Truck` 图标（如不再使用）。
- `src/routes/__root.tsx`：移除面包屑里 `logistics` 的映射（若有）。
- 不动 routeTree.gen.ts（自动重生成）。

### 4. "国内渠道" → "国内小包"

全局文案替换（保留路径 `/purchase/domestic`，避免破坏链接）：

- `src/components/app-sidebar.tsx`：菜单 title。
- `src/routes/purchase.domestic.index.tsx`：meta title + PageHeader title。
- `src/routes/purchase.domestic.import.tsx`：meta title。
- `src/routes/purchase.domestic.$id.tsx`：meta title。
- `src/routes/__root.tsx`：面包屑映射 `domestic: '国内小包'`。
- 仪表盘新分类卡 label 同步用"国内小包"。

### 5. 实施顺序

1. 写 `dashboard.functions.ts`（serverFn 聚合）。
2. 重写 `dashboard.tsx`。
3. 删除 logistics 路由 + 侧栏项。
4. "国内渠道"批量改名。
5. 浏览器预览验证三块 KPI + 趋势图 + 侧栏菜单。

### 不动

- `purchase.japan-bulk.tsx` 列表页本身（仍走旧 mock）。本次只接仪表盘统计，避免越界。
- 其他门店/库存/知识库模块。
