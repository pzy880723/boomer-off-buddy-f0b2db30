## 侧边栏新结构（`src/components/app-sidebar.tsx`）

```text
总览
  └ 仪表盘

商品管理                    ← 新分组
  └ 仓库商品   /inventory/skus       （从"仓库管理"迁入）
  └ 门店商品   /shop-mgmt/products   （从"门店管理"迁入，改名）
  └ 网店商品   /shop-mgmt/online     （新占位路由，暂放 placeholder 页）
  └ 商品分类   /settings/categories  （新增，指向系统设置→商品分类 Tab）
  └ 商品分组   /settings/groups      （新增，指向系统设置→商品分组 Tab；有赞店铺分组）

库存管理                    ← 由"仓库管理"改名，移除"仓库商品"
  └ 入库记录
  └ 调拨单
  └ 盘点单
  └ 待认领 EPC
  └ 库位管理
  └ 手持终端

门店管理
  └ 门店列表
  └ 加盟商管理
  └ 有赞门店

订单管理
  └ 门店订单
  └ 铺货订单
  └ 批发订单

采购物流
  └ 日本大宗 / 日本小包 / 国内大宗 / 国内小包

运营
  └ 知识库 / API 文档 / 系统设置

系统（仅超管）
  └ 账号管理
```

分组顺序：总览 → 商品管理 → 库存管理 → 门店管理 → 订单管理 → 采购物流 → 运营 → 系统。

## 需要新增的路由

- `src/routes/shop-mgmt.online.tsx`：网店商品占位页（`PageHeader` + `EmptyState` "网店模块规划中"），沿用现有 `shop-mgmt` 布局。
- **不新建** `/settings/categories`、`/settings/groups` 独立路由；直接让侧边栏 `Link` 用 `/settings` + `search: { tab: 'categories' | 'groups' }`，同时把 `settings.tsx` 的 `Tabs` 改成读 search param 作 `defaultValue`。这样侧边栏点"商品分类"能直达对应 Tab。

## `settings.tsx` 微调

- 沿用上一版分组结构，保留 `商品分类`（ERP 一二级，`kind='category'`）和 `商品分组`（有赞，`kind='group'`）两个 Tab（前一 plan 的产物）。
- 用 `Route.useSearch()` 读 `tab`，作为 `Tabs value`，切换时 `navigate({ search: { tab } })`。

## 类型 / 图标

`NavTo` 增加 `/shop-mgmt/online`。图标：网店商品用 `Globe`，商品分类用 `Tags`，商品分组用 `Layers` 或 `FolderTree`（保留一个，避免与"入库记录"重复）。

## 不改的东西

- 门店商品页 `/shop-mgmt/products` 内部逻辑不动，只是从"门店管理"移到"商品管理"。
- 门店管理原有 `门店商品库` 条目删掉（避免重复入口）。
- 采购物流各子项与订单管理子项不变，仅整体位置调整。

## 验收

- 侧边栏顺序与命名符合上述结构。
- 点击"商品管理 → 商品分类" / "商品分组" 分别落到 `/settings?tab=categories` / `?tab=groups`，进入即对应 Tab。
- `/shop-mgmt/online` 打开有占位页，不 404。
- 原"仓库管理"分组中的"仓库商品"消失（只在"商品管理"里出现一次）。
