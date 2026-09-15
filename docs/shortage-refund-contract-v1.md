# 缺货申报 → 客户确认 → 原路退款 合同 v1

状态：本仓库已实现（内嵌 Supabase 迁移已应用）。**腾讯生产未部署**，业务短信与退款 worker 生产开关默认关闭。

## 1. 客户端接口（小程序）

所有接口需要消费者 JWT（`authenticateStorefrontCustomer`）。归属一律以服务端解析出的 `customer_id` 过滤，**不接受客户端传入 customer_id**。

### GET `/api/public/storefront/shortages?order_id=<uuid>`
`order_id` 可选。→ `{ ok: true, data: { items: Case[] } }`

### GET `/api/public/storefront/shortages/:id`
→ `{ ok: true, data: Case }`；非本人 / 不存在一律 `404 { ok:false, code:"not_found" }`。

### POST `/api/public/storefront/shortages/:id/confirm-refund`
- body：`{ quote_version: string }`
- header：`Idempotency-Key: shortage:<id>:<quote_version>`（可选；若传且与服务端计算不一致 → 400）
- 200 → `{ ok: true, data: Case }`
- 409 → `{ ok:false, error:"Quote changed", code:"QUOTE_CHANGED" }`（客户端必须重新取数）
- 404 → 非本人或不存在
- 422 → `not_confirmable`（无可退金额 / 状态不可确认）
- 重复确认：返回同一退款意图的当前状态，**不会产生第二笔退款**。

### GET `/api/public/storefront/notifications`
→ `{ ok:true, data:{ items:[{id,title,body,shortage_id,order_id,read_at,created_at}], unread_count } }`
通知正文不含任何外部跳转 URL。

### POST `/api/public/storefront/notifications/:id/read`
幂等标已读，仅改 `read_at`，不确认退款、不改售后状态。

## 2. Case 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | string | 缺货单 ID |
| order_id | string | 订单 ID |
| order_no | string \| null | 订单号 |
| store_name | string \| null | 门店名（历史 location 名称） |
| product_name | string \| null | 商品名快照 |
| thumbnail_url | string \| null | **压缩衍生图**（160px）；无法安全转换时为 null，绝不回退原图 |
| quantity | number | 缺货件数 |
| reason | string \| null | 门店申报原因 |
| status | string | **仅客户意见**：pending_customer / customer_accepted / customer_cancelled / withdrawn |
| refund_state | string | awaiting_confirmation / queued / processing / succeeded / failed / manual_review（历史值折叠） |
| refund_goods_fen | integer | 商品退款，整数分 |
| refund_shipping_fen | integer | 运费退款，整数分 |
| refund_total_fen | integer | 合计，整数分 |
| quote_version | string \| null | 报价版本哈希，确认时必须回传 |
| can_confirm | boolean | **服务端真实资格**；UI 不得自行判断 |
| created_at / customer_responded_at / refund_requested_at / refunded_at | ISO 时间或 null | |

## 3. 金额规则

- 一律整数分，按**订单实付**最大余数法分摊，尾差落在确定行；同输入同结果。
- 商品级与支付级都有「已退 + 预占」上限，超出即封顶并转 `manual_review`。
- 只有某门店组**全部未发货**才退该组未履约运费；部分缺货不退整单运费。
- 无可验证运费快照或无法映射门店 → 不猜，进人工复核。

## 4. 数据库（迁移 `drizzle/migrations/0000_shortage_refund_v1.sql`，已应用）

- `fulfillment_shortages` 增列：`order_item_id, location_id, product_name, image_ref, quote_version, refund_goods_fen, refund_shipping_fen, refund_total_fen, quote_snapshot, after_sale_id, refund_intent_id, refund_requested_at, refunded_at`；`refund_state` CHECK 扩展为兼容旧值 + v1 新值。
- 新表：`commerce_customer_notifications`（客户售后/交易通知，**不复用员工 inv_handheld_notifications**）、`commerce_sms_outbox`（业务短信，与 OTP 独立；缺模板记 `template_missing` 而非假成功）、`commerce_refund_intents`（每个缺货唯一意图 + 唯一 `idempotency_key` + 租约 + 重试）。
- 三张新表：仅 `service_role` GRANT + RLS 策略，anon/authenticated 无访问。
- RPC（SECURITY DEFINER，仅 `service_role` 可执行，已 `REVOKE ... FROM PUBLIC, anon, authenticated`）：
  - `shortage_report_v1`：`FOR UPDATE` 锁 fulfillment_item/fulfillment，按 `expected - picked - 已申报` 原子限制可申报量；写缺货行 + 客户通知 + 短信 outbox；`client_op_id` 幂等回放。
  - `shortage_confirm_refund_v1`：锁缺货行，校验 `order.customer_id` 归属、`quote_version` 一致（否则 `QUOTE_CHANGED`）、金额 > 0、状态 `awaiting_confirmation`；同事务生成系统核定售后 + 唯一退款意图 + 通知；重复调用返回同一意图。

## 5. ERP 侧

`src/lib/fulfillment-shortage.functions.ts`（`requireSupabaseAuth`）：
- `getOrderStoreSubOrders`：按门店返回子单、每行应发/已发/已申报/可申报数量。
- `manualShipStoreSubOrder`：手工录入快递公司 + 单号 + 本次数量，**不依赖电子面单**；`idempotency_key` 幂等；超发拒绝。
- `reportStoreShortage`：服务端算报价后调用 `shortage_report_v1`。

页面：`/orders/fulfillment/$orderId`。

## 6. 尚未开启 / 待办

- 退款执行 worker（消费 `commerce_refund_intents`，复用原支付通道与相同商户退款号、租约、未知结果先查原退款号）：**未启用**。
- 腾讯业务短信模板（`shortage_reported` 等）未配置：outbox 记 `template_missing`，不会假装成功。
- 腾讯生产未部署；旧缺货数据不做自动批处理。

## 7. v2：旧缺货兼容 + 退款执行 worker（迁移 `drizzle/migrations/0002_shortage_refund_worker_v1.sql`，已应用）

### 7.1 新增接口

`GET /api/public/storefront/after-sales-summary`
→ `{ ok:true, data:{ pending_count:int, pending_shortage_count:int } }`
统计仍需客户处理的售后（当前为 `status=pending_customer` 的缺货，含历史缺货），**不依赖通知 `read_at`**，看消息不会清待办。

### 7.2 历史缺货

读列表/详情时，对 `status=pending_customer` 且缺少报价、且尚无退款意图的缺货，服务端按当前订单实付重新核算并通过 `shortage_attach_quote_v1` 落库：
- 可安全报价 → `refund_state=awaiting_confirmation` + `quote_version`，客户可直接确认。
- 无法安全报价（无运费快照 / 无法映射门店 / 金额 ≤ 0）→ `refund_state=manual_review`，金额 0，**不编造金额**。
- 旧接口 `POST /shortages/:id/respond` 不再只改意见：命中真实报价时走与 `confirm-refund` 完全相同的退款意图事务。

### 7.3 确认时的锁内复核

`shortage_confirm_refund_v1` 在锁内重新核对支付级上限：`实付 - (已退 + 其他未失败意图预占)`。超限即转 `manual_review`，不生成意图、不退款。报价不一致仍为 `QUOTE_CHANGED`，非本人 404。

### 7.4 退款执行 worker

- 策略：`src/lib/shortage-refund/worker-policy.ts`（最多 8 次；退避 60s 起指数、封顶 1 小时；未知结果按 processing 继续查询，超次数转 `manual_review`）。
- 执行：`src/server/refund-intent-worker.server.ts` + `src/server/shortage-refund-runtime.server.ts`，走原支付通道 `executeOrdinaryRefund`（原商户退款号、账本预占与上限校验、未知先查原退款号），**不伪造 HQ 角色**，HQ 原退款入口的角色守卫不变。
- 租约 RPC：`commerce_claim_refund_intents` / `commerce_claim_refund_intent`（`FOR UPDATE SKIP LOCKED` + 120s 租约，重复 worker 不会并发处理同一意图）、`commerce_settle_refund_intent`（校验 lease_token，同事务同步缺货 / 售后 / 客户通知）。全部 `service_role` only。
- 只有 provider 明确 `SUCCESS` 才写 `succeeded`；`PROCESSING`/网络未知继续查询，不会自动发起第二笔退款。
- 客户确认后立即尝试一次（`kickShortageRefund`）；进程崩溃由 worker 恢复。

### 7.5 开关与运行方式

- `SHORTAGE_REFUND_WORKER_ENABLED`（默认关闭）：未开启时服务端返回 `refund_worker_disabled` + HTTP 503，前端不得显示成功。
- 内部入口 `POST /api/internal/refunds/run`，Bearer `SHORTAGE_REFUND_WORKER_TOKEN`（≥32 字符，未配置返回 503）。
- 定时脚本 `scripts/run-shortage-refunds.mjs`（读环境变量 `SHORTAGE_REFUND_WORKER_TOKEN` / `SHORTAGE_REFUND_WORKER_URL`，令牌不进 argv/日志）。

### 7.6 仍未开启

- 腾讯生产未部署；业务短信模板未配置（记 `template_missing`）；worker 生产开关默认关闭；旧缺货不做批处理写入，只在客户本人读取时补报价。
