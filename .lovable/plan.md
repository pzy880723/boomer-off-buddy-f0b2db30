## 现状

数据库里数据是有的（121 个日本小包、469 个子项、近 ¥172,900），但仪表盘显示 0。

**根因**：`src/lib/dashboard.functions.ts` 的 `getPurchaseStats` 是 `createServerFn` 但没有挂 `requireSupabaseAuth`，handler 里用的是浏览器 `supabase` 客户端（无 session），所有表都开了 `authenticated` RLS，于是服务端查询全部被拒、返回空数据，前端拿到的全是 0。

## 改造方案

### 1. 修数据接入（核心）

`src/lib/dashboard.functions.ts`：
- 加 `requireSupabaseAuth` middleware，handler 内用 `context.supabase` 替换原来的浏览器 client
- 顺手补两件事：
  - 国内大宗的 `total_cny` 累加加上 `lines` 兜底（订单本身没填总价时按 lines 汇总），避免大宗看起来永远 0
  - 增加返回字段：日本小包按 5 档状态分布 `byStatus`、最近 5 笔记录 `recent`（包裹 / 国内 / 大宗 合并按时间倒序）

### 2. 重新设计仪表盘 UI

`src/routes/dashboard.tsx` 整体重写，按内部管理后台的实用主义改：

```
┌─ PageHeader  [周期切换：本月/本季度/本年/全部]
│
├─ KPI 4 卡： 本月采购 / 本月单数 / 本年累计 / 历史累计
│             (主卡 brand 渐变 + 同比小标)
│
├─ 左 2/3：12 个月堆叠柱状趋势（4 渠道颜色统一）
│  右 1/3：渠道占比环形图 + 列表（本月口径，可切换为累计）
│
├─ 左：日本小包状态分布（横向进度条 5 档：已采购→在日仓→国际运输→已签收→已完成）
│  右：最近动态（最近 10 条采购/到货事件，可点跳转详情）
│
└─ 待接入提示：日本大宗（保留占位卡片，挂"待接入"badge）
```

设计要点（沿用现有 token，不引新色）：
- 卡片用 `Card` + `hover:shadow-card-hover`，金额走 `tabular-nums`、主指标 `text-3xl`
- 4 渠道颜色固定：日本小包=chart-1、日本大宗=chart-2、国内小包=chart-3、国内大宗=chart-4
- 状态分布用 5 段堆叠 bar（每档一种 muted 色阶）
- 周期切换在前端做（loader 一次性返回全部聚合，按当前 tab 计算展示口径），避免重复请求

### 3. 不动的部分

- `getPurchaseStats` 返回 schema 向后兼容（新增字段为可选）
- `MetricCard` / `PageHeader` 组件保持不动
- 路由路径、菜单、其它页面均不动

## 验证

- 登录后打开 /dashboard，KPI 卡显示 ¥172,900 量级数字（不再是 0）
- 月度趋势 2024-09 ~ 2026-04 各月柱子高度对得上数据库聚合
- 切周期 tab 时图表与 KPI 同步刷新
- 大宗渠道目前 0 单 → 显示"暂无数据"但卡片仍渲染