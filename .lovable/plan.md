
# 门店商品库 + 库存调拨

## 一、命名调整（侧边栏）

把现有侧边栏第 3 组「商品库存」整组改成「**仓库管理**」：
- 「商品 SKU」→「**仓库商品**」（路径不变 `/inventory/skus`）
- 「扫枪入库」「入库记录」保持不动
- 新增子项「**调拨单**」`/inventory/transfers`（统一的调拨流水）

「门店加盟」组新增：
- 「**门店商品库**」`/stores/products`（跨店统一列表）

并在「门店列表 → 某店详情」里加一个「**商品**」Tab，复用同一套查询。

## 二、数据模型（新表）

**`stock_transfers`（调拨主表）**
- `id`、`code`（人类可读单号 `T-YYYYMMDD-xxx`）
- `kind`：`wh_to_shop` / `shop_to_shop` / `shop_to_wh` / `consume`（销售/损耗）
- `status`：`draft` / `posted` / `failed` / `void`
- `from_shop_id`（null = 仓库）、`to_shop_id`（null = 仓库或消耗）
- `from_sku_id`（仓库侧引用 inv_skus；门店侧为 null）
- `from_youzan_item_id` / `to_youzan_item_id`（bigint，门店侧引用 youzan_items.item_id）
- `qty`、`reason`（销售/损耗原因 enum：`offline_sale` / `damaged` / `lost` / `gift` / `other`）
- `operator`、`notes`
- `youzan_sync_status`：`pending` / `ok` / `failed`、`youzan_error_msg`
- `created_at`、`posted_at`

**`stock_transfer_lines`**（暂时按"单单"建表，每张单一行；预留多行扩展，避免后期改 schema）

不引入 SKU↔有赞商品绑定表（按你确认「暂不强绑定」）。仓库 → 门店调拨时，由用户在调拨弹窗里手动指定"这件仓库 SKU 对应到该店的哪个有赞商品"，系统记录在调拨单上但不持久化为绑定关系。

## 三、页面与交互

### 1. `/stores/products`（门店商品库 · 统一列表）
- 顶部筛选：门店多选、上下架状态、关键词、库存阈值
- 表格列：商品图 / 标题 / 门店 / 价格 / 有赞库存 / 状态 / 最近同步时间 / 操作
- 操作按钮：
  - **同步该店商品**（拉取最新 youzan_items，复用现有 `syncYouzanItems`）
  - **调拨入库**（弹窗：选源 = 仓库 SKU；目标 = 当前行所在门店该商品；填数量）
  - **调出**（弹窗：目标可选「另一门店商品 / 退回仓库 SKU / 销售损耗」）
  - **直接改库存**（兜底：仅在有赞写绝对值，不进调拨流水，加二次确认）

### 2. `/stores/list/$id`（单店详情新增 Tab）
同样的列表，预先按当前 shop_id 过滤；右上角加「**一件同步全部仓库 SKU 到本店**」按钮（批量调拨：选中若干仓库 SKU + 各自数量 + 各自对应有赞商品，提交一张多行调拨单）。

### 3. `/inventory/transfers`（调拨单流水）
- 列表：单号、类型、源/目标、数量、状态、有赞同步结果、操作员、时间
- 详情抽屉：完整字段 + 失败时显示有赞错误 + 「重试推送有赞」按钮

## 四、调拨业务逻辑（serverFn）

新文件 `src/lib/stock-transfer.functions.ts`：

- `createTransfer(input)` —— 原子流程：
  1. 校验源侧库存够（仓库查 `inv_skus.stock_qty`；门店查 `youzan_items.stock_qty` 本地缓存）
  2. 调用有赞 `youzan.item.quantity.update`（或 sku 维度接口）——**先调有赞、成功后才落本地账**，失败直接返回错误，不创建调拨单
     - `wh_to_shop`：目标店 +qty
     - `shop_to_shop`：源店 -qty、目标店 +qty（两次调用，第二次失败则补回滚源店）
     - `shop_to_wh`：源店 -qty
     - `consume`：源店 -qty
  3. 本地写 `stock_transfers` 记录 + 同步更新 `inv_skus.stock_qty`（仓库侧）与 `youzan_items.stock_qty`（缓存值）
  4. 全部用一个 `youzan_sync_logs` action=`stock_transfer` 关联
- `retryTransferSync(id)` —— 针对历史失败单
- `listTransfers(filter)`、`getTransfer(id)`

复用现有 `fetchSilentToken` 拿 access_token 调有赞 API。

## 五、技术细节

- 有赞改库存接口：使用 `youzan.item.quantity.update`（绝对值）或 `youzan.item.quantity.increment`（增量）。增量更安全（避免并发覆盖），优先用增量接口；接口选型在 serverFn 里抽个 helper 统一处理。
- 调拨弹窗的「目标有赞商品选择器」：复用 youzan_items 的列表查询，按 shop_id 过滤、支持搜索（标题/item_id）。
- 「一件同步」批量操作：单次最多 50 行，超出分批；每行独立成单（失败不影响其他），最终汇总成功/失败数。
- RLS：4 张相关表沿用现有 `open_*` 全公开策略。
- 侧边栏文案改动只动 `src/components/app-sidebar.tsx`，不动现有路由文件 URL。

## 六、不在本期范围

- SKU 与有赞商品的持久化绑定关系（你确认暂缓）
- 自动按编码匹配
- 调拨审批流（直接 posted，不走 draft 审批）

---

确认后我会按这个方案落地：先建 `stock_transfers` 迁移 → 写 serverFn → 做 `/stores/products` 和调拨弹窗 → 调拨流水页 → 单店 Tab + 一件同步 → 最后改侧边栏命名。
