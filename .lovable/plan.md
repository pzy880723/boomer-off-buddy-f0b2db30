## 目标

1. 从有赞总部抓一次分类树，落到 ERP 一张新表 `inv_categories`。
2. 以后 SKU/商品/APP/下拉 全部读这张表，硬编码的 10 个分类只作为初始种子。
3. 有赞侧新加分类不会自动改 ERP，需要在设置页手动"同步 + 采纳"，ERP 就是唯一真源；反向推送到有赞暂不做（有赞后台仍能改，改完再同步过来自己决定是否采纳）。
4. 设置入口：`/settings` 新增 tab「商品分类」。

## 用户可见改动

### 设置入口
- `/settings` → 新 tab **「商品分类」**（图标 `Tags`），排在「地址库」之后、「通知」之前。
- 页面结构（一屏搞定，不做子路由）：
  - 顶部工具条：`＋ 新建分类`、`↻ 从有赞同步`（HQ 权限）、`导出 CSV`。
  - 左侧：**分类树**（可拖拽调序、点击选中）；每节点显示 `名称 · code · 商品数 · 有赞映射角标`。
  - 右侧：选中分类的**编辑面板**（名称 / 短码 code / 排序 / 上级 / 状态启停 / 有赞映射 id + 来源 shop）。
  - 底部：**同步预览抽屉** —— 拉完有赞后不直接写库，先列出「新增 X / 更新 Y / 已停用 Z / 未匹配 N」，用户勾选后一键采纳。

### SKU / 商品下拉
- 现在硬编码的 `INV_CATEGORIES` 全部改成从新接口 `listCategories()` 读，加 30s React Query 缓存。
- PC 端 SKU 编辑、移动端 `m/skus`、APP `/handheld/products` 下拉都受益，无需逐个改字段。

### 权限
- 编辑/同步：`super_admin` + `hq_operator`。
- 门店只读。

## 数据模型（新迁移）

```text
inv_categories
  id uuid pk
  code text unique         -- 短码，用于 EPC/SKU 编号，如 JP/EU/TY，同步来的自动生成拼音首字母
  name text                -- 显示名
  parent_id uuid null      -- 支持有赞多级树
  sort_order int default 0
  is_active bool default true
  is_system bool default false -- 初始种子，防误删
  youzan_hq_category_id bigint null unique
  youzan_shop_id uuid null      -- 来自哪个 HQ 店同步
  synced_at timestamptz null
  created_at / updated_at
```

- RLS：`authenticated` 可读；`service_role` + HQ 角色写。
- 迁移里 seed 现在的 10 个分类（`is_system=true`），把 `inv_skus.category` 保留为 text，值就是 `code`，无需 backfill。

## 有赞同步管线

### 用哪个接口
`src/lib/youzan.functions.ts` 里已有 `callYouzanApi`。总部分类优先按顺序试：
1. `youzan.retail.product.standardcategory.get` v3.0.0（新零售总部标准类目）
2. `youzan.itemcategories.get` v3.0.0（经典店铺兼容）
3. 都失败则报「当前授权账号无分类读取权限」。

命中的接口固化到 `youzan_shops.meta.category_api` 下次直接用。

### 新 server fn（`src/lib/youzan-categories.functions.ts`）
- `listCategories()` → 读 `inv_categories`，返回树。
- `previewSyncFromYouzan()` → 拉有赞分类树，diff 出 `to_add / to_update / to_deactivate`，**不写库**。
- `applySyncFromYouzan({ picks })` → 按用户勾选写入，产生一条 `youzan_sync_logs`。
- `upsertCategory({ id?, name, code, parent_id, sort_order, is_active })`
- `deleteCategory({ id })` —— 有 SKU 引用时禁止删除，只能停用。

### 展示层
- 新增 `src/hooks/use-categories.ts` 封装 `useQuery(['inv-categories'])`。
- 全局替换：`import { INV_CATEGORIES }` → `useCategories()`。硬编码常量保留一份 `SEED_CATEGORIES` 只给迁移种子用，禁止在业务代码里 import。

## 技术要点

- 有赞分类多级 → ERP 平铺 + `parent_id`，UI 用递归组件渲染树。
- `code` 冲突时自动加数字后缀（`JP` / `JP2`）；同步来的分类首选拼音首字母 + 有赞 id 后 2 位。
- APP 端 OpenAPI 无需改（`category` 仍是 string）；等分类稳定后再决定要不要给 APP 加 `/handheld/categories` 接口，本轮不做。
- 有赞反向推送、门店级分类：本轮都不做，页面上加一句说明。

## 文件改动清单

新增：
- `supabase/migrations/*_inv_categories.sql`（含种子）
- `src/lib/youzan-categories.functions.ts`
- `src/hooks/use-categories.ts`
- `src/components/settings/categories-panel.tsx`（树 + 编辑 + 同步抽屉）

改动：
- `src/routes/settings.tsx`：加 tab 与面板。
- `src/lib/inventory.helpers.ts`：`INV_CATEGORIES` 改名 `SEED_CATEGORIES`，加 deprecated 注释。
- `src/lib/inventory.functions.ts`：`z.enum(CATEGORY_VALUES)` 改成 `z.string()`，服务端校验改成"存在于 inv_categories 且 active"。
- 用到 `INV_CATEGORIES` 的组件（SKU 编辑弹窗、筛选下拉等）：改成 `useCategories()`。

## 验收

1. `/settings → 商品分类` 能看到当前 10 个种子分类。
2. 点「从有赞同步」出现 diff 抽屉，勾选后写库并显示同步时间。
3. 新建 SKU 时下拉里出现刚同步来的分类。
4. 有赞后台改分类名，再同步 → diff 显示 "更新 1"，采纳后 ERP 更新。
5. 停用某分类后，SKU 编辑下拉不再显示，但已有 SKU 展示不受影响。
