## 背景
上一版 `/settings` 同步过来的是有赞后台的**官方标准类目**（`youzan.itemcategories.get` / `retail.product.category.get`），但你实际想要的是**店铺自建分组**——就是有赞后台「商品 → 分组管理」里维护、给前台导航/橱窗用的那套。两者概念不同：类目是平台属性，分组才是店铺自己的货架分类。

## 目标
- 同步入口从「官方类目」切成「店铺分组」（HQ 总部店铺）。
- 完全替换：清理旧的类目映射数据，之后 `inv_categories` 只承载「分组」。
- UI 文案 / 字段命名跟着改，避免以后再混淆。

## 实施步骤

### 1. 数据模型微调（migration）
- `inv_categories` 新增字段：
  - `youzan_hq_group_id bigint`
  - `youzan_hq_group_parent_id bigint`
  - `kind text check (kind in ('group','category')) default 'group'`
- 一次性数据迁移：把现有 `youzan_hq_category_id != null` 的行标记 `kind='category'` 并 `is_active=false`（不物理删除，避免误伤已经绑 SKU 的），后续 UI 默认只显示 `kind='group'`。
- 保留旧列以便回滚，但代码不再写入。

### 2. 有赞 API 接入（`src/lib/categories.functions.ts`）
用「店铺分组」相关接口，按优先级尝试并 fallback：
- `youzan.itemcategories.shop.get`（电商店铺分组，主用）
- `youzan.shop.categories.get` / `youzan.shop.category.list`（旧名兼容）
- `youzan.retail.product.shopcategory.get`（零售版店铺分组，兜底）

复用已有的 `callYouzanApiVerbose` + `classifyYouzanError`，保留 IP 白名单 / gw4005 的报错提示逻辑（用户上一轮修的部分不动）。
`normalizeCats` 复用：分组接口返回结构大同小异（`id/name/parent_id/sort`），补上 `sort_order` 归一。

### 3. `previewYouzanCategorySync` / `applyYouzanCategorySync` 调整
- 匹配键从 `youzan_hq_category_id` 换成 `youzan_hq_group_id`。
- 新增行统一写 `kind='group'`。
- `to_deactivate` 只针对 `kind='group'` 且已从有赞侧删除的分组。
- 返回体字段名保留（前端少动），内部注释统一改成「分组」。

### 4. 前端 (`src/components/settings/categories-panel.tsx` + `/settings` 标签)
- 侧栏 / Tab 标题：`商品分类` → `商品分组`。
- 同步按钮文案：`从有赞同步` → `从有赞拉取店铺分组`。
- 预览弹窗表头、说明文案、note 提示语全部改「分组」。
- 树形展示逻辑不变（分组本身也有一/二级）。

### 5. SKU 侧引用
`useCategories()` 消费方式不变（依然吐出 `code + name`），只是数据源换成分组。`sku-meta-fields.tsx` 等无需改动。

## 技术细节

```text
有赞后台            ERP 里的对应体
──────────         ──────────────
商品 → 分组管理  →  inv_categories (kind='group')  ← 本次同步目标
商品 → 类目 (平台) →  inv_categories (kind='category', 已停用)  ← 旧数据封存
```

同步流程：
```text
[HQ 店铺 token]
      │
      ▼
callYouzanApi(itemcategories.shop.get) ─fallback→ retail.shopcategory.get
      │
      ▼
normalizeCats → {id,name,parent_id}[]
      │
      ▼
diff vs inv_categories WHERE youzan_hq_group_id IS NOT NULL
      │
      ▼
preview UI (add / update / deactivate) → 用户确认 → apply
```

## 不做的事
- 不删旧 `youzan_hq_category_id` 列（保留历史 & 回滚空间）。
- 不动 SKU 上的 `category` 字段（依旧存 `code`）。
- 不引入「商品标签 itemtags」——你选了只要分组。
