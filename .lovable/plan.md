## 背景

上一版把「店铺分组」同步接口试了三个：
`itemcategories.shop.get` / `shop.categories.get` / `retail.product.shopcategory.get`，全部 gw 4005「非法的 API」。你已确认权限申请通过，所以问题就是**接口名选错了**。

有赞云团队在官方论坛的答复（thread-699886）明确：
- 商品所属分组 → `youzan.items.custom.get` 返回体里的 `tag_ids`
- 查询分组本身（一级 + 二级）→ **`youzan.itemcategories.tags.get`**
  - 字段：`id / name / upper_id / type`
  - `upper_id = 0` → 一级分组；否则 → 父分组 id
  - `type = 0` → 商家自定义分组（就是我们要的「商品分组」）

我们只用第二个接口就够（同步分组树），商品和分组的绑定后面再做。

## 实施步骤

### 1. `src/lib/categories.functions.ts` — `fetchYouzanHqGroups()`
- attempts 列表清空，只保留：
  ```
  { method: "youzan.itemcategories.tags.get", version: "3.0.0" }
  ```
  （保留 try/catch + `classifyYouzanError` 的 IP / 4005 / 4007 处理不动。）
- `normalizeGroups()` 增加对 tags 结构的解析：
  - 从 payload 中读 `tags` / `data.tags` / `categories` 兜底
  - 每个节点映射：
    - `id ← id`
    - `name ← name`
    - `parent_id ← upper_id === 0 ? null : upper_id`
    - `sort_order ← order ?? 0`
  - 过滤 `type != null && type !== 0`（只留自定义分组，排除系统分类）
  - 一次拉平返回，一级/二级都在同一数组里（前端按 `parent_id` 组树）。

### 2. UI 文案
- `CategoriesPanel` / 同步预览：把 note 里显示的 API 名换成新接口，其余不动。

### 3. 兜底文案
- 如果分页字段存在（`total_results / has_next`），补分页循环；没有就单次调用。先按有赞返回观察，如果只有一页就不做分页（tags 数量一般 < 200）。

## 不做的事
- 不改 `inv_categories` 表结构（v2 迁移已经把 `youzan_hq_group_id / kind` 建好了）。
- 不同步商品与分组的绑定关系（后续需求，另开）。
- 不动 IP 白名单 / 错误分类逻辑。

## 验收
- `/settings → 商品分组 → 从有赞拉取店铺分组`：note 里出现
  `youzan.itemcategories.tags.get ✅ 拉取成功 · N`，预览弹窗按父/子结构列出所有一/二级分组，确认后写入 `inv_categories(kind='group')`。
