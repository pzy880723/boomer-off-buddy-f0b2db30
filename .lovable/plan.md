## 调整：搜索结果按当前 tab 过滤，不再跨 tab

### 现状
后端 `listJapanParcels` 在有搜索词时会无视 tab，把"已采购 / 已签收 / 问题件 / 全部"的匹配结果一起返回（除了回收站），导致在「已签收」tab 搜索也会看到已采购的包裹，不好区分。

### 改动
只改 `src/lib/japan-parcel.functions.ts` 的 `listJapanParcels`：

- 删除"搜索时跨 tab"的特殊逻辑。
- 不论是否有搜索词，都按当前 tab 应用对应过滤：
  - `all` → 仅 `deleted_at is null`
  - `purchased` → `status in PURCHASED_STATUSES`
  - `delivered` → `status in DELIVERED_STATUSES`
  - `problem` → `is_problem = true`
  - `trash` → `deleted_at is not null`
- 搜索关键词的 `.or(...)` 拼装逻辑保持不变（子商品匹配 + 父级字段匹配）。

### 不动
- 前端 tab 切换、搜索框、搜索按钮、商品视图本地过滤（史努比那次的修复）都保持原样。
- counts 接口、回收站、批量操作等不变。

### 验证
- 在「已签收」tab 搜索一个只存在于"已采购"包裹的关键词 → 结果为空（符合预期）。
- 在「全部」tab 搜同一关键词 → 能搜到。
- 清空搜索 → 各 tab 列表恢复正常。
