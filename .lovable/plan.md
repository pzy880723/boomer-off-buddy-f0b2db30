
## 目标

1. 侧边栏「商品分类」「商品分组」合并为一项 **商品分类**，跳转到独立页面 `/product-categories`（不再进系统设置）。
2. 一个页面同时承担：ERP 自建一二级分类的 CRUD + 与有赞店铺分组的一一对应绑定。
3. 商品同步到有赞时，按绑定关系落到对应有赞类目；有赞独有的类目忽略（以 ERP 为准）。

## 页面布局 `/product-categories`

```text
┌───────────────────────────── 商品分类 ──────────────────────────────┐
│ [新建一级]  [从有赞拉取最新]     状态: 未绑定 3 / 已绑定 12 / 有赞独有 5│
├──────────────────────────┬─────────────────────────────────────────┤
│  ERP 分类 (可编辑)        │  有赞店铺分组 (只读, 来自 HQ)             │
│  ─────────────────────   │  ─────────────────────────────────────   │
│  ▸ 服饰                  │  ▸ 服饰类目                              │
│     · T恤    [已绑 →t恤] │     · T恤        [已绑 ← 服饰/T恤]        │
│     · 卫衣    ○ 未绑     │     · 卫衣        ○ 未绑                 │
│  ▸ 配饰      ○ 未绑     │  ▸ 家居 (有赞独有, 灰显)                  │
│  ▸ 家居                 │                                         │
│     · 摆件   ⚠ 有赞无    │                                         │
│                          │                                         │
│  [+ 新建二级]            │                                         │
└──────────────────────────┴─────────────────────────────────────────┘
```

### 交互
- 左侧点选一个 ERP 叶子分类 → 右侧同类项高亮可点 → 点击右侧对应分组即完成绑定；已绑定行显示反向指示与「解绑」。
- 左侧支持新建/重命名/排序/删除一级与二级（禁止删除已有 SKU 引用的分类，给出提示）。
- 顶部「从有赞拉取最新」触发一次同步，右侧刷新；沿用现有 `fetchYouzanHqGroups` 逻辑，不再写入 `inv_categories`，改写入独立缓存表（见下）。
- 顶部统计三种状态：未绑定 ERP / 已绑定 / 有赞独有（灰显，仅提示，不建对应关系）。
- 「ERP 有 + 有赞无」的叶子在保存 SKU 或点「推送到有赞」时，自动在有赞创建对应分组，然后回填绑定（新增按钮：单个「推到有赞」）。

## 数据模型

**保留** `inv_categories`，语义收敛为「ERP 自建分类」：
- `kind` 字段：值统一为 `'category'`；把当前 `kind='group'` 的历史行标记 `is_active=false` 或迁移（见下）。
- 新增/复用字段：`parent_id`（二级挂一级）、`sort_order`、`code`、`name`、`is_active`。
- 保留 `youzan_hq_group_id` / `youzan_hq_group_parent_id` 作为**绑定关系**字段（一一对应），不再当缓存。

**新增缓存表** `youzan_hq_groups_cache`（只读快照，用于右侧渲染，避免污染 ERP 分类）：
```
id (uuid pk), youzan_group_id (text uniq), parent_youzan_group_id (text null),
name (text), level (int), fetched_at (timestamptz), raw (jsonb)
```
GRANT + RLS：authenticated select，service_role all。

**迁移策略**：把 `inv_categories` 中 `kind='group'` 且 `youzan_hq_group_id` 非空的行，`name/parent` 复制到 `youzan_hq_groups_cache`，然后原行 `is_active=false`；`kind='category'` 保留为 ERP 分类种子。

## 侧边栏与路由改动

- `src/components/app-sidebar.tsx`：删除「商品分组」项；「商品分类」`url` 改为 `/product-categories`（去掉 `search: { tab }`）。
- 新建路由 `src/routes/product-categories.tsx`，组件承载上述双栏页面。
- `src/routes/settings.tsx`：移除 `categories`、`groups` 两个 Tab 与相关 NAV_GROUP「商品」组；不再接受 `?tab=categories|groups`。
- `CategoriesPanel` 组件不再挂在 settings；其查询/mutation 逻辑拆分复用到新页面的「ERP 侧」组件。

## Server functions（`src/lib/categories.functions.ts` 扩展）

- `listErpCategories()` – 返回 ERP 树（kind=category, is_active=true）+ 每项当前绑定的有赞 group_id。
- `upsertErpCategory({ id?, parent_id, name, code, sort_order })` / `deleteErpCategory({ id })`（删除前校验 SKU 引用）。
- `bindErpToYouzan({ erp_id, youzan_group_id | null })` – null 即解绑。
- `syncYouzanGroupsCache()` – 拉取有赞 HQ 分组写入 `youzan_hq_groups_cache`（复用 `fetchYouzanHqGroups`）。
- `listYouzanGroupsCache()` – 返回右侧树 + 每项反向绑定的 ERP id。
- `pushErpCategoryToYouzan({ erp_id })` – 单个「推到有赞」，成功后自动 `bindErpToYouzan`（后续可做，先在 UI 留按钮/占位）。

## SKU 侧影响

- SKU 表的分类外键仍指向 `inv_categories`（kind=category）。
- 之前挂在 `kind=group` 行的 SKU 需要一次性映射到新 ERP 分类（迁移里按 `youzan_hq_group_id` 或名字对齐）。
- `useCategories()`：`FALLBACK` 与 `active` 已过滤 `is_active`，天然兼容；只需确认查询过滤 `kind='category'`。

## 交付步骤

1. 迁移：`youzan_hq_groups_cache` 建表 + GRANT + RLS；把 `inv_categories.kind='group'` 行归档并复制到 cache；把 `inv_categories.kind='category'` 作为初始 ERP 分类。
2. 后端：新增/改造上述 server functions。
3. 前端：新建 `/product-categories` 页面（左右双栏 + 绑定交互 + 拉取按钮）。
4. 侧边栏 & settings：删掉「商品分组」，「商品分类」改路由，settings 去掉两个 Tab。
5. 保留旧 URL 兼容：`/settings?tab=categories|groups` 在 settings 组件里 redirect 到 `/product-categories`。

## 不做

- 不改动 SKU 编辑弹窗的分类选择器（继续用 `useCategories`）。
- 不改动有赞同步 worker（后续接入绑定关系时再单独调整）。
- 「推到有赞新建分组」本轮先留按钮+ toast「待接入」，等你确认有赞创建分组的 API 权限后再实现。
