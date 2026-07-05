## 目标
让「标准商品 · 编辑」弹窗里的**类目**变成可修改字段。新建弹窗本来就有类目选项，不动。

## 变更范围（都在 `updateStandardProduct` + 编辑弹窗）

### 1. `src/components/inventory/product-edit-dialog.tsx`
- 去掉 `<SkuMetaFields ... hideCategory />`，改成显示类目下拉。
- `mut.mutationFn` 里把 `category` 传给 `updateStandardProduct`：仅当用户改动了类目时才传（用 `meta.category !== group.category` 判断），避免无意义写入。
- 弹窗顶部说明改为：「修改类目会重算 EPC 前缀并更新该商品下全部价格档；若任一价格档有库存或入库记录，修改类目会失败。」
- 保存成功 toast 追加「已改类目」提示。

### 2. `src/lib/inventory.functions.ts` — `updateStandardProduct`
- 输入 schema 的 `patch` 增加 `category: z.string().min(1).optional()`。
- handler 逻辑扩展：
  - 拉出的 `matched` 记录同时选 `epc, sku_code, stock_qty`。
  - 若 `patch.category` 与当前 `category` 不同：
    1. **前置校验**：任一子 SKU `stock_qty > 0` 直接抛「类目变更前请先清空库存」；任一子 SKU 在 `inv_inbound_lines` 出现过（复用 `safeDeleteSkuById` 里那段查询逻辑抽出的 helper）→ 抛「已有入库记录，禁止改类目」。
    2. **重算 EPC**：对每条 matched row 调 `generateEpc(newCategory, price_tier)` 生成新 EPC；同时若 `sku_code` 是「自动生成前缀」形式（`SKU-` 开头），一并调 `generateSkuCode(newCategory, "single")` 刷新，否则保留用户自定义值。
    3. 用一次 `update` 把 `category / epc / sku_code`（可选）写回；由于 `epc` 有唯一约束，冲突时直接抛错让用户处理。
  - 新增价格档时（`toAdd`）用**新类目**生成 `epc` / `sku_code`（把 `category` 变量指向 `patch.category ?? ref.category`，已经如此）。
- 由于类目改后 `key` 会变（`category|name` 或 `sku_code`），返回值加 `newKey` 字段，前端 `onSaved` 触发列表 refetch 即可（详情页 route param 是 code，用户可能停留在旧 URL；此处不做自动跳转，保持最小改动）。

### 3. 无 DB 迁移
`inv_skus.category` 已存在且可写；不新增列。EPC 唯一冲突交由数据库约束抛错。

## 不改动
- 新建弹窗 `StandardSkuDialog`（类目本来就有）。
- 自定义 / 组包 SKU 的编辑逻辑。
- 有赞同步：类目变更不主动重推有赞（用户如需重新绑定分组，走现有 `/product-categories`）。

## 边界与失败提示
- 有库存 / 有入库记录 → 阻止（明确文案）。
- 新 EPC 冲突 → 「EPC 冲突，请先在库存/未认领 EPC 里清理」。
- 用户改类目 + 改价格档同一次提交：先执行类目迁移，再走原有价格档 add/remove 分支。
