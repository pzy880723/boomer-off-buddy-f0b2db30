# 有赞同步逻辑重构（v2 · 分店直连模型）

## 目标模型

- **有赞 HQ kdt** = SPU 主数据中心。ERP 新建 SKU 时在 HQ 建一次商品（拿到 HQ item_id / 图片 / 类目），**永远不推库存**。
- **ERP 总仓库位** = 实物源头。库存变化只落本地账，**不推任何有赞店**。
- **ERP 分店库位** ↔ **有赞分店 kdt**：1:1 对齐库存。SKU 第一次要在某分店上架时，ERP 自动在该分店 kdt 建 item（复用 HQ 的图 / 标题 / 类目 / 价格），拿回 branch_item_id 后立刻推库存。
- **调拨** = 总仓 −N、分店 +N，只推分店那家 kdt（HQ 无动作）。
- **销售** = 分店库位 −1，只推该分店 kdt。

## 与现状差异

| 场景 | 现状（v1） | 新版（v2） |
|---|---|---|
| 仓库入库 | 推 HQ | 不推任何店 |
| 调拨发货 | 推 HQ（源） | 不推 |
| 调拨收货 | 推 HQ + 分店 | 只推目的分店 |
| 分店首次上架 | 需人工在有赞后台建品 + 手动绑定 | ERP 自动在分店 kdt 建 item |
| HQ 库存 | 会被反复覆盖 | 永远不动 |

## 技术方案

### 1. 数据模型微调
- `sku_youzan_links`：保留每条记录代表「SKU × 某个 kdt」的绑定。新增列 `role`（`hq_spu` | `branch_stock`），HQ 那条永久 `role='hq_spu'` 且 `sync_stock=false`。
- `youzan_stock_sync_queue`：`action` 支持 `create_branch_item` / `push_stock`；不再产生任何 HQ 的 push_stock 任务。

### 2. 库位 → 分店映射
- `inv_locations.kind='shop'` 必须绑定 `youzan_shops.id`（无绑定 = 不推）。
- `kind='warehouse'` 的库位库存变化**直接跳过入队**。

### 3. 触发点改造
- `enqueueStockPushForLocation()`：只在 shop 库位入队；warehouse 库位早退返回。
- `inbound.scan.ts`（总仓入库）：移除 enqueue 调用。
- `transfer.ship-confirm.ts`：源如果是分店才推源，源是总仓则不推。
- `transfer.receive-confirm.ts`：只推目的分店（目的一般是分店；若是总仓则不推）。
- POS 销售扣减（未来）：推该分店。

### 4. SKU 建品
- **HQ 建 SPU**：`items.smart-create` 完成本地 SKU 后异步入队一次 `create_hq_item`（仅第一次），拿到 item_id 写回 `sku_youzan_links(role='hq_spu', sync_stock=false)`。
- **分店建 item**：当某个 sku 在分店库位首次出现 +N 时，worker 检测到该 (sku, shop) 没有 `branch_stock` 链接，先执行 `create_branch_item`（复制 HQ item 的标题/图/类目/价格 → 调用分店 kdt 的商品新增 API），成功后写入 link，再执行同一任务的 `push_stock`。

### 5. Worker 变化
- `runStockSyncWorkerCore`：
  - 跳过 `role='hq_spu'` 的任何 push_stock 任务；
  - 处理 `push_stock` 时按 (sku, shop) 找 link，缺失 → 触发 `create_branch_item` 子任务；
  - 推送数字始终 = `inv_stocks.qty` where location.shop_id = 该 shop。

### 6. 历史数据清理
- 对存量 `sku_youzan_links.role IS NULL` 的记录：如果 kdt 是 HQ，标 `hq_spu` 并停用 sync_stock；如果是分店，标 `branch_stock`。
- 清空 `youzan_stock_sync_queue` 里所有 target=HQ 且 action=push_stock 的 pending 任务。

### 7. UI
- `SkuYouzanCard` 拆两块显示：**HQ 商品**（只显示 item_id / 打开有赞后台链接 / 没有库存数字）+ **分店库存**（列出每家已开通分店的 item_id + 上次推送 / 上次对账 / 错误）。
- `/youzan` 同步中心：任务列表增加 shop 列，过滤器加「只看分店」。

### 8. 分店建品 API（需要在编码时踩坑确认）
- 有赞分店 kdt 建商品需要 `youzan.item.add` 类接口 + 图片上传接口。这一步包成 `createBranchItem(shopId, hqItem)`，字段有缺失（运费模板、类目 id 分店端不同）会在 worker 里记 `last_error` 让人工介入。

## 开发顺序

1. Schema 迁移：新增 `role` 列 + 数据回填 + 清 pending HQ 任务。
2. `enqueueStockPushForLocation` + 三个 handheld 触发点改造（跳过总仓）。
3. Worker 升级：识别 `role`，只处理分店任务。
4. `create_branch_item` 流程（含 HQ item 复制、字段兜底、失败保留 last_error 人工重试）。
5. `items.smart-create` 增加「HQ 建 SPU」入队（一次性）。
6. UI 拆分展示 HQ / 分店。
7. 给 Codex 的手持机指令：说明库位不再需要绑 HQ，只需要绑分店 shop_id；调拨发货/收货成功后不用再期待 HQ 更新。

## 需要你在实施前确认（非阻塞，可留到实施时）

- **分店 SPU 复制策略**：分店建 item 时的价格默认取本地 SKU 的哪个字段（零售价 / 建议售价 / HQ item 原价）？
- **首次建品失败**：如果分店建品失败（类目不匹配等），是保留任务 `failed` 等人工修字段重试，还是自动回退到「只绑不建，等人手在有赞后台建好后手动绑定」？我建议前者。
