# 仓库 / 门店库存管理 v3（RFID-only）

核心原则（按你最新确认）：
- **入库的唯一真源 = RFID 手持终端扫描**，没有任何手动入库入口
- 手持终端登录绑定到「仓库」或「门店」；扫到的 EPC 落到对应位置的库存
- **门店不入库**，门店只用 RFID 做盘点
- 库存按 (SKU, 位置) 拆分；总仓 + N 个门店各一份
- 调拨**必须扫具体 EPC**（发出扫一次、收到扫一次）
- 盘点差异：门店提交 → 总部审核 → 生效
- 扫到系统里没有的 EPC：进「待认领」队列

> 手持终端本身**先不动**，本轮只搭好后台数据结构、HTTP 接入点和 Web 端管理页面。接口先用调试工具或 Web 模拟器调通即可。

---

## 一、位置与库存模型

````text
inv_locations(
  id, kind: 'warehouse' | 'shop',
  name, shop_id 可空 → youzan_shops,
  is_active, created_at
)
-- 自动初始化:1 条 warehouse(总仓) + 每个 youzan_shops 一条 shop

inv_stocks(sku_id, location_id, qty)  PK=(sku_id, location_id)

inv_stock_movements(
  id, sku_id, location_id, delta, balance_after,
  ref_type: 'rfid_inbound' | 'transfer_out' | 'transfer_in'
          | 'stocktake_adjust' | 'youzan_sale' | 'unclaim',
  ref_id, epc 可空, note, created_by, created_at
)
````

`inv_skus.stock_qty` 仅作总仓快照保留（兼容老页面），新代码全部读 `inv_stocks`。
迁移时把现有 `inv_skus.stock_qty` 整体迁到「总仓」位置。

## 二、EPC 唯一性 & 待认领

现状是「同款 SKU 共用 EPC」，但你说**必须扫具体 EPC** 才能调拨。我建议加一层 **EPC 实例表**，与 SKU 配套：

````text
inv_epcs(
  epc PRIMARY KEY,
  sku_id 可空 → inv_skus,          -- 未认领时为空
  current_location_id 可空,         -- 当前在哪个位置（空=已售/未入）
  status: 'unclaimed' | 'in_stock' | 'sold' | 'lost',
  first_seen_at, last_seen_at
)

inv_unclaimed_epcs(
  epc, last_seen_location_id, last_seen_at, hits
)  -- 简化版,扫到未知就 upsert
````

- 打印 RFID 时（`inv_label_batches`）就在 `inv_epcs` 里预写 sku_id+status='unclaimed'（待入库）
- 扫到的 EPC 在 `inv_epcs` 里查不到 → 写进 `inv_unclaimed_epcs`，**不动库存**，后台「待认领」页面手动绑定 SKU 后再补入
- 这样调拨时扫 EPC 就能精准知道是哪个具体物件

> 如果你打印 RFID 时已经在用「批量生成 EPC 范围」，会按 `inv_label_batches` 的范围批量预写 `inv_epcs`，无需重新打印。

## 三、入库流程（仓库 RFID）

接入点：`POST /api/public/hooks/rfid-scan`

````json
{
  "device_id": "HH-001",
  "location_id": "uuid-of-warehouse",
  "epcs": ["E2001234...", "E2001235..."],
  "scanned_at": "2026-06-14T10:00:00Z"
}
````

handler 逻辑：
1. 校验签名/设备 token（先实现简单的 X-Device-Token，留下扩展点）
2. 校验 `location.kind === 'warehouse'`（门店扫描走另一个端点，见下）
3. 对每个 EPC：
   - 在 `inv_epcs` 里查；未找到 → upsert 到 `inv_unclaimed_epcs`，跳过
   - 找到 → `inv_stocks(sku, warehouse) += 1`，`inv_epcs.current_location_id = warehouse`、`status='in_stock'`
   - 写 `inv_stock_movements(ref_type='rfid_inbound')`
4. 入库完成后，对涉及到 SKU 异步 `enqueueStockPush`（仓库本身不直接对应有赞门店，但若调拨后已分布到门店则推那些门店——这里只补总数缓存）
5. 返回 `{ accepted, unclaimed, skipped }`

`inv_inbound_orders`：保留并升级，每次 RFID 上报生成一张 order（source=`rfid`，自动 posted）。**移除所有手动入库 server fn/页面/路由**。

## 四、门店 RFID 扫描（用于盘点）

接入点：`POST /api/public/hooks/rfid-store-scan`

````json
{
  "device_id": "HH-002",
  "location_id": "uuid-of-shop",
  "stocktake_id": "uuid",          // 必填,先在后台开盘点单
  "epcs": [...],
  "scanned_at": "..."
}
````

handler：
- 把 EPC 追加到 `stocktake_scans(stocktake_id, epc, scanned_at)`
- 未知 EPC 同样进 `inv_unclaimed_epcs`
- **不改库存**

## 五、盘点流程（门店提交 → 总部审核 → 生效）

````text
stocktakes(
  id, code, location_id,
  status: 'scanning' | 'submitted' | 'approved' | 'rejected',
  opened_by, opened_at,
  submitted_at, submitted_by,
  reviewed_at, reviewed_by, review_note
)
stocktake_scans(stocktake_id, epc, scanned_at)
stocktake_lines(
  stocktake_id, sku_id,
  system_qty, counted_qty, diff, reason
)  -- 提交时按 SKU 聚合 stocktake_scans 计算 counted_qty
````

UI：
- `/inventory/stocktakes`：盘点单列表（按门店筛选）
- `/inventory/stocktakes/new`：选门店 → 创建 scanning 单 → 提示「请用手持终端扫描，本页可看到实时进度」（轮询 `stocktake_scans`）
- `/inventory/stocktakes/$id`：扫完点「提交」→ 自动聚合生成 lines（含差异）→ status=submitted
- 总部 `/inventory/stocktakes`（带「待审核」tab）：批准 → 按差额一次性调整 `inv_stocks`、写流水（`stocktake_adjust`）、对该门店推有赞库存；驳回 → 写原因，回到 scanning

## 六、调拨流程（必须扫 EPC，两步）

````text
stock_transfers (升级现表)
  status: 'draft' | 'in_transit' | 'received' | 'cancelled'
  from_location_id, to_location_id
  shipped_at, shipped_by, received_at, received_by

stock_transfer_lines(transfer_id, sku_id, qty)       -- 明细

stock_transfer_epcs(
  transfer_id, epc,
  ship_scanned_at, receive_scanned_at
)  -- 具体扫了哪些 EPC
````

流程：
1. 后台 `/inventory/transfers/new` 选 源/目的位置 → 草稿
2. 手持端登录到「源」位置，进入该调拨单扫描 → 写 `stock_transfer_epcs.ship_scanned_at`；点「发出」时：
   - 校验每个扫到的 EPC `current_location_id === from`
   - `inv_stocks(sku, from) -= n`，EPC `current_location_id = NULL`（在途）
   - 流水 `transfer_out`；状态 → in_transit
3. 手持端登录到「目的」位置，扫该调拨单 → 写 `receive_scanned_at`；点「收到」时：
   - 校验扫到的 EPC 都属于此调拨单
   - `inv_stocks(sku, to) += n`，EPC `current_location_id = to`、`status='in_stock'`
   - 流水 `transfer_in`；对源/目的门店推有赞；状态 → received
4. 缺扫/多扫的 EPC 在收货页面会列出来，方便人工处理

> 接口形态与「门店盘点扫描」一致：`POST /api/public/hooks/rfid-transfer-scan { transfer_id, stage: 'ship'|'receive', epcs }`。

## 七、待认领 EPC 管理

`/inventory/unclaimed`：
- 列表：epc / 最后扫到位置 / 次数 / 时间
- 操作：选 SKU → 「认领并补入库」→ 在该位置 `inv_stocks += 1`、写流水 `unclaim`、`inv_epcs` 写入正式记录、从 `inv_unclaimed_epcs` 删除
- 或「忽略」→ 删除记录

## 八、有赞同步联动（沿用现有 `enqueueStockPush`）

触发点：
- 仓库 RFID 入库：仅刷新本地，不推门店（总仓不对应有赞门店）
- 调拨「收到」：源、目的门店各推
- 盘点「批准」：目标门店推
- 手动认领并补入库：对应位置如果是门店，则推

## 九、改动清单

**数据库迁移（一条 migration）**
- 新表：`inv_locations`、`inv_stocks`、`inv_stock_movements`、`inv_epcs`、`inv_unclaimed_epcs`、`stock_transfer_lines`、`stock_transfer_epcs`、`stocktakes`、`stocktake_scans`、`stocktake_lines`
- 扩字段：`stock_transfers`、`inv_inbound_orders`（标记 source/location）
- 数据迁移：建总仓 + 各 youzan_shops 对应 location；现有 `inv_skus.stock_qty` → 总仓 `inv_stocks`；现有 `inv_label_batches` 反推生成 `inv_epcs` 占位记录（status='unclaimed'，sku_id 已知）
- 完整 GRANT + RLS
- RPC：`inv_apply_movement(sku_id, location_id, delta, ref_type, ref_id, epc)`

**Server fns / Routes**
- 新：`src/lib/rfid-scan.functions.ts`（被 webhook 路由调用的内部处理函数；以及 Web 端模拟扫描的入口，方便没有手持端时本地测试）
- 新公开路由：
  - `/api/public/hooks/rfid-warehouse-scan`
  - `/api/public/hooks/rfid-store-scan`
  - `/api/public/hooks/rfid-transfer-scan`
  （全部用 `X-Device-Token` 简单校验，留 TODO 升级签名）
- 新：`src/lib/stocktake.functions.ts`、`src/lib/transfer-v2.functions.ts`
- 改：`src/lib/inventory.functions.ts` 删 `submitInbound` 等手动入库相关；改读 `inv_stocks`
- 改：`src/lib/stock-transfer.functions.ts` → 拆 create/ship/receive/cancel

**UI**
- 删：`/inventory/inbound/new`（手动入库页）
- 改：`/inventory/inbound` & `/inventory/inbound/$id` → 仅展示 RFID 自动生成的入库记录
- 新：`/inventory/locations`（位置管理）
- 新：`/inventory/unclaimed`（待认领 EPC）
- 新：`/inventory/stocktakes`、`/inventory/stocktakes/new`、`/inventory/stocktakes/$id`
- 改：`/inventory/transfers`、新 `/inventory/transfers/new`、`/inventory/transfers/$id` 两步状态机 + EPC 扫描进度
- 改：SKU 详情页 → 「分位置库存」表格 + 「该 SKU 名下 EPC 列表」
- 改：侧边栏：去掉「扫枪入库」入口；新增「盘点」「待认领 EPC」「位置」
- 改：`/m/inbound`、`/store.scan` 等老移动端入库页 → 全部下线或改成「请使用手持终端」提示

**模拟扫描调试器**（搭后台时必备）
- 在 `/inventory/locations/$id` 加一个「模拟扫描 EPC」面板，粘贴 EPC 列表 + 选场景（入库 / 盘点 / 调拨发出 / 调拨收到）→ 直接调内部 server fn 走全套流程。
- 上线手持端前用它跑回归。

---

## 待你最终确认 2 件事

1. **手持端 token**：先用最简单的 `X-Device-Token`（每个 device 在后台 `inv_handheld_devices(id, label, location_id, token, last_seen_at)` 表里登记），可以吗？还是你们手持端用人员账号 JWT？
2. **EPC 占位**：要不要在本次迁移里把现有 `inv_label_batches` 全部回溯生成 `inv_epcs`（status='unclaimed'）？这样过往打印的标签也能被识别，不至于全进「待认领」。

确认后我开始落迁移和代码。
