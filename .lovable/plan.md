
## 目标

本地 `inv_skus` ↔ 有赞总部账号商品 **1:1 绑定**，本地为库存唯一真源。

核心原则（按你最新要求调整）：
- **本地新建 SKU 不自动推送**，避免在有赞重复建商品
- 关联方式 **以"绑定已有"为主，推送为辅**
- 已有 SKU 的页面提供醒目「绑定有赞商品」入口；只有确认有赞那边没有时才点「推送过去」
- 一旦绑定，库存变动实时单向推有赞，并有巡检兜底

---

## 数据模型

### `sku_youzan_links`（绑定关系，1:1）

| 字段 | 说明 |
|---|---|
| id | uuid pk |
| sku_id | uuid → inv_skus.id（unique） |
| shop_id | uuid → youzan_shops.id（role=hq） |
| yz_item_id | bigint（有赞 SPU/item_id） |
| yz_sku_id | bigint nullable（多规格时记选中的规格 sku_id；无规格留空） |
| last_pushed_stock | int |
| last_pushed_at | timestamptz |
| last_pull_stock | int |
| last_pull_at | timestamptz |
| status | `linked` / `mismatch` / `error` |
| last_error | text |
| created_at / updated_at |

唯一索引：`(shop_id, yz_item_id, yz_sku_id)`、`sku_id`。

### `youzan_stock_sync_queue`（实时推送队列 + 失败重试）

| 字段 | 说明 |
|---|---|
| id | uuid |
| sku_id | uuid |
| target_stock | int |
| reason | text（inbound / transfer / manual / repair…） |
| status | `pending` / `running` / `done` / `failed` |
| attempts | int |
| next_run_at | timestamptz |
| last_error | text |
| created_at / updated_at |

索引 `status, next_run_at`。

---

## 服务端 (`src/lib/youzan-sync.functions.ts`)

全部 `requireSupabaseAuth`。

1. **`searchYouzanItems({ q, limit })`** — 关键字搜 `youzan_items`（标题 / item_id 模糊），返回已被其它 SKU 绑定的标记，供"绑定弹窗"使用
2. **`linkSkuToYouzanItem({ sku_id, yz_item_id, yz_sku_id? })`** — 手动绑定，唯一约束防止重复占用，绑完立即触发一次"以本地库存为准"的推送
3. **`unlinkSku({ sku_id })`** — 解绑
4. **`pushSkuAsNewYouzanItem({ sku_id })`** — 手动按钮：在有赞调 `youzan.retail.open.spu.add` 建商品，成功后写 `sku_youzan_links` 完成关联（保留为应急入口，UI 上有二次确认 "确认有赞那边没有这个商品？"）
5. **`pullYouzanItemAsSku({ yz_item_id })`** — 从已同步的 `youzan_items` 行生成本地 SKU 占位（category=待补、price_tier=价格、name=title），并完成关联
6. **`enqueueStockPush({ sku_id, reason })`** — 写入队列
7. **`runStockSyncWorker({ sku_ids?, limit? })`** — 消费队列，调有赞 `youzan.retail.open.stock.update`（覆盖到目标值），指数回退 30s→5m→30m→2h，5 次失败终止
8. **`reconcileAll()`** — 全量拉总部 SPU 库存 vs 本地 `stock_qty`，差异标记 `status='mismatch'`，**不自动覆盖**
9. **`repairMismatch({ sku_id })`** — 一键以本地为准修复（重新入队）

### 库存事件源接入

封装 `applyStockChange(sku_id, delta | absolute, reason)`：
- 内部先调 RPC（沿用 `inv_apply_inbound_stock` / `inv_apply_stock_delta`）
- 成功后查 `sku_youzan_links` 是否绑定 → 有就 `enqueueStockPush` 并 **同请求内 await `runStockSyncWorker({ sku_ids:[id] })`**（用户感知立即推送完成）

替换现有所有直接调 RPC 改库存的位置（入库 / 调拨 / 手动调整）。

### 兜底触发

`/api/public/hooks/youzan-stock-worker` — pg_cron 每 1 分钟跑一次，处理 `failed AND next_run_at<=now()` 的任务
`/api/public/hooks/youzan-reconcile` — pg_cron 每天 03:00 跑一次全量对账

两个公共路由都用 anon apikey 头校验。

---

## UI

### 1. SKU 列表 `/inventory/skus`

每行新增「有赞」列：
- 已绑定 → 显示绿点 + `yz_item_id`，hover 显示状态（同步/一致/异常/失败）
- 未绑定 → 显示按钮「🔗 绑定有赞」，点开弹窗（见 2）

### 2. **「绑定有赞商品」弹窗**（核心入口）

打开后默认进入「搜索绑定」tab：

- **Tab A：搜索已有商品绑定**（默认）
  - 顶部搜索框 → 调 `searchYouzanItems`
  - 列表展示有赞商品：缩略图 / 标题 / 价格 / 当前库存 / item_id / 是否已被占用
  - 单选 + 「确认绑定」→ 调 `linkSkuToYouzanItem`
  - 绑定成功 toast：「已绑定，本地库存 X 已推送到有赞」

- **Tab B：在有赞新建商品**（次要，灰色二级位置）
  - 二次确认弹层 "确定有赞没有此商品？重复建会产生重复商品"
  - 确认后调 `pushSkuAsNewYouzanItem`

> 同步中心 (`/youzan/sync`) 的「未关联 SKU」批量操作 **不提供** 批量推送按钮，只提供"逐个去绑定"链接，避免误操作批量重复建。

### 3. SKU 详情页

底部新增「有赞同步」卡片：
- 已绑定：展示 `yz_item_id` + 状态 + 最近 5 条推送记录 + 按钮「立即重推」「解绑」「打开有赞商品页」
- 未绑定：醒目"未绑定"提示 + 按钮「绑定有赞商品」

### 4. 新页面 `/youzan/sync`（同步中心）

四个 tab：
- **未绑定的本地 SKU**：每行「去绑定」按钮（打开同一个弹窗）
- **未绑定的有赞商品**（`youzan_items` LEFT JOIN links）：按钮「拉到本地建 SKU」/「关联现有本地 SKU」（弹搜索）
- **同步异常**（mismatch / error）：展示「本地 X / 有赞 Y / 差值」+ 按钮「以本地为准修复」
- **推送队列**：最近 100 条 queue，可手动重跑失败项

侧栏「有赞」下加入口。

### 5. 新建 SKU 流程

保存成功后 toast：「SKU 已创建，请到列表/详情页点击『绑定有赞』完成关联」
**不弹询问框，不自动推送**。

---

## 有赞 API

| 用途 | method |
|---|---|
| 总部 SPU 查询（已有） | `youzan.retail.open.spu.query` 3.0.0 |
| 总部 SPU 新建 | `youzan.retail.open.spu.add` 3.0.0（仅手动按钮调用） |
| 总部 SPU 详情 | `youzan.retail.open.spu.get` 1.0.0（绑定时校验商品存在 + 拉当前库存） |
| 总部库存覆盖 | `youzan.retail.open.stock.update` 1.0.0（set 模式到目标值） |

封装时复用现有 `callYouzanApiVerbose` 与 `ensureAccessToken`。

---

## 一致性策略

- 推送幂等：每个 queue 任务用 `queue.id` 当 `client_seq`
- 任一推送 5 次仍失败 → `status='failed'` + 列表红标
- 巡检发现不一致 → 仅标记，由人按按钮触发修复
- 删本地 SKU 不级联删有赞；仅自动解绑
- 有赞侧通过订单售出导致的扣库存：本期 **不回拉**，因"本地为准"；担心超卖时由巡检覆盖

---

## 落地步骤

1. 迁移：建 `sku_youzan_links` + `youzan_stock_sync_queue`（含 GRANT + RLS）
2. 实现 `youzan-sync.functions.ts` + 两个 `/api/public/hooks/*` 路由
3. 封装 `applyStockChange`，替换入库/调拨等直接改库存的位置
4. 配置 pg_cron：1 分钟重试 + 每日 03:00 对账
5. SKU 列表 + 详情接入「绑定有赞」入口与「有赞同步」卡片
6. 新建 `/youzan/sync` 同步中心页（4 tab）
7. 文档 & memory 更新

---

## 暂不做

- 自动推送新 SKU 到有赞
- 多店分仓库存
- 商品资料（名称/价格/图片）双向同步（仅库存）
- 分店级 stock 推送
