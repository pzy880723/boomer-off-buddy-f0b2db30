
## 目标

严格按你上传的《BOOMER ERP 有赞全渠道孤品库存同步实施规格》落地全渠道同步：ERP 是库存唯一真源，孤品库存只能 0/1；总部 SPU → 线下门店/线上网店发布 → 共享库存 → 自动上下架；支付/退款走统一幂等 `commitSale` + outbox worker；员工验收才恢复库存。整个改造分 9 阶段（对应规格 §14 实施顺序），每阶段独立可验收、可回滚。

---

## 阶段 0 · 现状盘点与冻结（本轮先做）

不改任何主链路，只做：

1. 只读审计 `src/lib/youzan-sync.functions.ts`、`youzan-api-registry.ts`、`youzan-stock-worker.ts`、`youzan-relist.ts`、`youzan-fix-channel.ts`、`items.smart-create.ts`（如有）、`commit`/`inv_apply_movement` 相关 RPC，输出「现有能力 vs 规格差距表」记入 `.lovable/plan.md`。
2. 冻结旧路径：给 `youzan.item.add`、`stock.adjust`（用于门店销售库存）、直接改 `inv_skus.stock_qty` 的 POS 代码统一加短路 `throw`，避免继续污染数据。
3. 保留 `youzan-relist / -fix-channel / -distribution-probe / -cleanup` 作为运维工具，标为「历史」。
4. 记忆持久化：把「ERP 是库存唯一真源，孤品 0/1」「四类对象 & 状态机」写入 `mem://features/youzan-omnichannel-model.md`，并更新 `mem://index.md`。

## 阶段 1 · 数据模型升级（DB 迁移）

一份幂等迁移，包含：

- 新表 `inventory_sale_events`（含 `(source_channel, source_order_id, event_type)` 唯一约束、`raw_payload`、`status`）。
- 新表 `sku_channel_listings`（`sku_id / channel / shop_id / external_*` / `listing_status` / `stock_mode` / `last_stock` / `last_verified_at`，唯一键 `(sku_id, channel, shop_id)`），把现有 `sku_youzan_links` 数据一次性映射迁入（HQ SPU → `channel='youzan_hq'`；branch → `youzan_offline`）。旧表保留只读兼容。
- 新表 `channel_sync_outbox`：`action` 支持 §8.3 的 11 个动作 + `inventory_version` + `dedupe_key` 唯一 + `worker_id / claimed_at / lease_expires_at` + 状态 `pending/running/succeeded/retry_wait/dead_letter/superseded/cancelled`。
- 新表 `return_inspections`。
- `inv_skus` 增字段 `sales_state`（§3.3 状态机）+ `inventory_version bigint`；每次 `inv_apply_movement` 通过触发器/RPC `+1`。
- RPC `claim_channel_sync_tasks(worker_id, limit)`：`FOR UPDATE SKIP LOCKED`。
- RPC `commit_sale(...)`：单事务里做幂等校验 → 锁 sku → 校验 qty=1 → 写 movement 扣到 0 → 状态置 `sold_syncing` → 写 outbox → 返回。缺库存时写 `oversold_exception` 而不是负数。
- RPC `restore_after_return_inspection(...)`：验收通过时才 +1。
- 所有新表：GRANT + 严格 RLS + `service_role` 全权。

## 阶段 2 · 商品发布链路（总部 SPU + 线下 + 线上）

改造 `youzan-sync.functions.ts`：

- 停用 `youzan.item.add` 分店建品，删除 `ensureBranchProduct` 的自动 fallback。
- HQ SPU 走 `youzan.retail.open.spu.create/3.0.0`（保留现有稳定 `sku_code`），复用现有素材上传管线。
- 新增 `publishOfflineListing`：`youzan.retail.open.offline.spu.release` + `.query` 回查，写 `sku_channel_listings(channel='youzan_offline')`。
- 新增 `publishOnlineListing`：`youzan.retail.open.online.spu.release` + `.query`，写 `channel='youzan_online'`。
- `verify_listing` 单独 outbox 动作，回查后才允许 `shelf`。
- `youzan-api-registry.ts` 补齐这些 method 的 `token_scope / business_scene / required_params / response_keys / allow_retry / allow_fire_and_forget`。

## 阶段 3 · 库存与自动上下架

- `set_stock`：按 `stock_mode` 分派——门店现货用官方门店商品更新（非 `stock.adjust`）；网店走共享库存不再单独写。
- `set_stock_zero`：高优先级、短退避，售出后必发。
- `shelf` / `delist`：线下 `retail.open.offline.spu.batch.shelf`；线上 `youzan.item.display.update`（禁用已下线的 `item.update.branch.display`）。
- `verify_stock` 回查并写 `last_stock`。
- 所有目标库存来自 `inv_stocks`，禁止回退到 `inv_skus.stock_qty`。

## 阶段 4 · 统一销售入口 `commitSale`

- 新 serverFn `commitSale({ skuId, epc?, sourceChannel, sourceShopId, sourceOrderId, paidAt, operator? })`：只调用 RPC `commit_sale`，触发一次 worker。
- ERP 手持 POS 支付成功、后续 `orders.dispatch` 出库、`shop-mgmt` 端 POS 全部改走这个函数；禁掉任何直接改 `stock_qty` 的路径。
- 幂等键 `(source_channel, source_order_id)`；重复调用返回首次结果。

## 阶段 5 · 有赞消息 webhook

改造 `src/routes/api/public/hooks/youzan-message.ts`：

- 验签 → 保存原始消息到 `youzan_sync_logs`（现有）+ `inventory_sale_events`（新）→ 快速 200。
- 按 `event_type` 路由：
  - `TRADE_TradePaid` / 零售 `KdsTaskChange`（支付成功）→ 后台任务：拉一次 `trade.get/4.0.2` 或零售任务详情 → 抽取 `sku_code / external_sku_id / kdt_id / order_id` → 反查本地 `sku_id` → `commit_sale`。
  - `TRADE_TradeRefund` → 状态 `sold → return_pending`，**不加库存、不上架**。
  - 映射不到 SKU → 写 `oversold_exception` 或 `unmatched` 到异常队列。
- 消息版本 `event_version` 单调保护，旧版本不覆盖新状态。

## 阶段 6 · 退款验收与恢复

- 后台新增页面 `/inventory/return-inspections`（PC）+ `/m/return-inspect`（手持机）：扫 EPC → 显示原订单/退款 → 选实际入库门店 → 通过/拒绝。
- 通过 → 调 RPC `restore_after_return_inspection` → 写 `+1` movement + `inventory_version++` + 状态 `publishing` + outbox `restore_after_return`（触发 `verify_listing → set_stock → verify_stock → shelf → active`）。
- 拒绝 → 状态 `retired`，库存保持 0。

## 阶段 7 · Worker 通用化 + 触发与鉴权

- 把 `youzan-stock-worker.ts` 改造为 `channel-sync-worker`：入口 `POST /api/public/hooks/channel-sync-worker`，鉴权改用新 secret `CHANNEL_SYNC_WORKER_SECRET`（用 `generate_secret` 生成，恒定时间比较）。
- 领取用 `claim_channel_sync_tasks` RPC；每条任务执行前重读 `inventory_version`，落后即 `superseded`。
- 分动作 handler：`create_hq_spu / publish_offline / publish_online / verify_listing / set_stock / set_stock_zero / shelf / delist / verify_stock / restore_after_return / reconcile`。
- 重试策略按 §15.8；到上限进 `dead_letter`。
- 触发：serverFn 写 outbox 后 fire-and-forget 调 worker（失败不影响事务）+ pg_cron 每 1 分钟兜底 + 每 5 分钟对账。

## 阶段 8 · 异常中心与对账

- 新页面 `/youzan/exceptions`：列出「已售但渠道未归零」「已售但仍上架」「ERP=1 但未发布」「库存不一致」「未映射订单」「oversold」「dead_letter」。每行都能重试/关闭/查完整链路（按 `sku_id / order_id / task_id` 串联日志）。
- 商品详情页新增「全渠道同步状态」板块（现有 `SkuYouzanCard` 扩展为多渠道）。
- 对账 job：`reconcile` outbox 动作，5 分钟高风险 + 每日全量。

## 阶段 9 · 旧数据迁移

- 一次性运维接口 `/api/public/hooks/youzan-legacy-migrate`：dry-run 默认打开，输出「将迁移 / 将解绑 / 将删除」清单；确认后：
  - 扫 `sku_youzan_links` 里 `role='branch_stock'` 的老 `item.add` 副本（可通过 `youzan_sync_logs.action='item_add'` 反查），解绑 + 有赞侧下架（保留商品别删，避免影响历史订单）。
  - 通过阶段 2 的正确链路重新发布 → 阶段 3 同步库存。
- 保留 `inv_stock_movements` 和原始日志。

---

## 技术细节

- 有赞 API 版本严格按规格：`retail.open.spu.create/3.0.0`、`retail.open.offline.spu.release`、`retail.open.online.spu.release`、`retail.open.offline.spu.batch.shelf`、`item.display.update`、`trades.sold.get/4.0.4`、`trade.get/4.0.2`、`trade.refund.search/3.0.1`、`trade.refund.get/3.0.1`。所有调用继续走 `youzan-http.ts` 固定出口代理。
- 禁止：`youzan.item.add`（分店建品）、`stock.adjust`（门店销售库存）、`item.update.branch.display`、直接改 `inv_skus.stock_qty`。这些路径在阶段 0 就短路 `throw`。
- 幂等 dedupe_key：`{sku_id}:{channel_listing_id}:{action}:{inventory_version}`。
- Secrets：新增 `CHANNEL_SYNC_WORKER_SECRET`（generate_secret）；已有 `YOUZAN_*` 复用。
- 表结构变更全部走单向迁移，`GRANT + RLS + service_role` 三件套齐全。
- `sku_youzan_links` 保留只读，新代码只读写 `sku_channel_listings`。

## 每阶段验收（引用规格 §13）

每阶段结束前跑对应 checklist；阶段 2–3 用现有中信泰富店 `test / 测试商品` 两条真数据端到端跑通再进入下一阶段。

## 本轮执行范围建议

规格总量 ~1000 行，一次性做完风险太高。建议**本轮先执行阶段 0 + 阶段 1**（盘点 + 数据模型迁移 + `commit_sale` / `claim_channel_sync_tasks` RPC 骨架），把地基打稳；阶段 2 起每轮做 1 个阶段，每轮结束都能跑通一小段端到端场景。

---

## 请你确认

1. 是否同意「本轮只做阶段 0 + 阶段 1（盘点 + 数据模型迁移 + 核心 RPC 骨架）」，后续按阶段推进？
2. 阶段 9 的旧测试数据只涉及中信泰富店的 `test / 测试商品`（HQ SPU `6046780206` / `6044984028`）以及历史 `item.add` 建的网店副本，对吗？还有其他真实生产商品在有赞后台已经跑通不能动？
3. 前后端在同一个仓库（当前 TanStack Start 项目），规格 §15 说的「配套后端 Worker」我理解就是当前项目 `/api/public/hooks/*` 路由 + pg_cron 触发，不再单独起独立 Worker 服务，对吗？
