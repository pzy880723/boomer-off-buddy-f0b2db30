# 缺货申报 → 客户确认 → 自动原路退款：只读核查与最小接法

腾讯生产基线仍为 `1e7a4ee-compressed-images-20260913`，本轮只读核查，未改代码、未迁移数据库、未发短信、未发起支付或退款。

## 1. 现状事实（已实查）

### 表结构（内嵌 Supabase，只读）
- `fulfillment_shortages`：`id, fulfillment_id, fulfillment_item_id, exception_id, order_id, quantity, reason, status, refund_state, reported_by, device_id, client_op_id, customer_responded_at, customer_response_note, created_at, updated_at`
  - CHECK `status ∈ (pending_customer, customer_accepted, customer_cancelled, withdrawn)`
  - CHECK `refund_state ∈ (not_required, refund_pending, refund_completed)`
  - 缺口：没有 `order_item_id`、`refund_amount`、`after_sale_id`、`refund_id`，无法把缺货行与退款金额、退款记录绑定。
- `commerce_after_sales`：`status ∈ (requested…refund_pending, refunded, closed, cancelled)`，有 `requested_amount / approved_amount / order_item_id / location_id / user_id`。
- `commerce_refunds`：`payment_id, after_sale_id, amount, status ∈ (pending, processing, succeeded, failed, cancelled), merchant_refund_no, idempotency_key, lease_token, lease_expires_at, provider_refund_id, route_snapshot`。
- `commerce_order_items`：有 `unit_price, quantity, line_total, original_unit_price, discount_total, discount_snapshot`（分摊后金额可直接取 `line_total`）。
- `commerce_orders`：只有整单 `shipping_fee / discount_total / total_amount`，按门店运费只在 `courier_quote_snapshot.groups[].shipping_fee_fen` 快照里，没有行级运费列。
- `inv_handheld_notifications`：`kind, title, payload, audience, user_id, device_id, location_id, action_status, ref_type, ref_id` —— 员工侧站内消息可直接复用（`ref_type='shortage'`）。

### 真实退款的硬条件（`commerce_prepare_ordinary_refund` + `startOrdinaryRefund`）
- 支付必须 `payment_channel='ordinary_wechat'` 且 `status ∈ (succeeded, partially_refunded, refunded)`。
- 必须存在 `commerce_after_sales` 行，且 `order_id` 与支付一致、`status='refund_pending'`、`approved_amount` 非空且 `0 < approved_amount ≤ requested_amount`。
- 同一 `after_sale_id` 只允许一个退款意图；租约 `lease_token/lease_expires_at` 提供并发预占；累计退款不得超过 `payment.amount`。
- `startOrdinaryRefund`（`src/server/ordinary-refund-flow.ts:49`）**硬编码要求调用者 roles 含 `super_admin | hq_operator`**，并校验商户快照；`payments.refund.ts` 又用 `authenticatePosUser` 做总部 POS 鉴权。
- 因此「客户确认即自动退款」当前无法直接复用：缺客户身份的服务端执行路径，且缺 after_sale 自动生成/审批置位。

### 其他入口现状
- `POST /api/public/handheld/fulfillments/$id/shortage`：按 `client_op_id` 幂等，写 `fulfillment_exceptions` + `fulfillment_shortages(status=pending_customer, refund_state=refund_pending)`；不写通知、不发短信、不建 after_sale。
- `POST /api/public/storefront/shortages/$id/respond`：本人订单校验走 `commerce_orders.customer_id`，只改 `status`，注释明确不伪造退款。
- `GET /api/public/storefront/shortages`：仅列表。
- `POST …/fulfillments/$id/waybill`：`carrierCapability()` 依赖 `COURIER_PROVIDER_CODE`，POST 恒返回 409/501，**没有手工录入快递单号的接口**；`shipments` 表已存在（GET 读取 `provider, tracking_no, status`），但无写入路径、无"发货事务"（订单状态/履约状态/物流事件联动）实现。
- 短信：只有 `sendOtpSms`（`src/server/sms.tencent.server.ts`），TC3 签名齐全但**模板写死单变量验证码**，`TENCENT_SMS_TEMPLATE_ID` 只有一个；无业务通知模板、无发送回执表、无重试/outbox。`deliverStoredOtp` 只在失败时删除 OTP。
- 消费者站内消息：可复用 `support_conversations / support_messages`（已有 storefront 端点）。
- 身份错位风险：`commerce_create_after_sale(p_user_id …)` 按 `commerce_orders.user_id` 校验归属，而门店订单本人鉴权走 `customer_id`，小程序客户直连该 RPC 会命中 "order is not eligible"。

## 2. 最小安全设计（推荐接法，未实施）

### 迁移（一次，加列不破坏）
1. `fulfillment_shortages` 增列：`order_item_id uuid`、`refund_amount numeric`、`after_sale_id uuid`、`refund_id uuid`、`customer_confirm_token`（可选）、`notified_at`、状态扩展 `refund_processing/refund_succeeded/refund_failed` 走独立列而非改现有 CHECK —— 缺货状态与退款状态分离：`status` 只表达客户意见，`refund_state` 只表达资金结果。
2. 新 RPC `commerce_confirm_shortage_refund(p_shortage_id, p_customer_id, p_expected_amount, p_idempotency_key)`：单事务内
   - `FOR UPDATE` 锁 shortage + order，校验 `order.customer_id = p_customer_id`、`status='pending_customer'`；
   - 金额**服务端自算**（`line_total / quantity × 缺货数量`，从 `commerce_order_items` 取，绝不接受客户端传值；`p_expected_amount` 只做一致性比对，不一致报错）；
   - 自动建 `commerce_after_sales(type='refund_only', status='refund_pending', requested_amount=approved_amount=服务端金额, user_id=订单 user_id, location_id=行 location_id)`，写 `after_sale_id` 回 shortage；
   - 返回 `payment_id + after_sale_id + idempotency_key`（由 `shortage_id` 派生，保证重放同键）。
3. 不新增总部审批：审批位由该 RPC 在客户确认时写入，并在 `commerce_membership_admin_audit_logs` 同类审计表留痕（或新增 `shortage` 审计）。

### 服务端
4. `startOrdinaryRefund` 增加一个受控执行身份，而不是放宽 roles：新增 `actor: { kind: 'customer_confirmed', shortageId }` 分支，要求调用方已通过 `commerce_confirm_shortage_refund` 返回的凭据；总部 POS 路径保持原样。
5. 新路由 `POST /api/public/storefront/shortages/$id/confirm-refund`：`authenticateStorefrontCustomer` → RPC → `startOrdinaryRefund`（幂等键 = `shortage:{id}`）→ 失败只落 `refund_state` 与失败原因，绝不返回商户/签名信息。真实结果仍以 `payments.wechat-notify` / `payments.reconcile` 回写为准（`commerce_apply_ordinary_refund`），确认接口只允许把 `refund_state` 推进到 `refund_processing`。
6. 通知三路同步（缺货申报时触发，一次事务后异步）：
   - 短信：新增 `TENCENT_SMS_TEMPLATE_ID_SHORTAGE` + 通用 `sendTemplateSms(phone, templateId, params[])`（复用现有 TC3 签名），新增 `notification_deliveries` 表记录 `serial / code / message` 回执与重试；
   - 站内消息：向订单会话写 `support_messages`（系统消息，带 shortage 深链）；
   - 售后处理入口：写 `inv_handheld_notifications(kind='shortage_pending', ref_type='shortage', ref_id, audience/location_id=履约门店)`。

### 发货与运费
7. 手工快递单：现无可复用实现，建议 `POST …/fulfillments/$id/waybill` 增加 `mode='manual'` 分支，事务内写 `shipments(provider='manual', tracking_no)` + `shipment_events` + 履约/订单状态推进，与未配置的真实面单能力并存。
8. 运费与优惠分摊：商品金额直接用 `commerce_order_items.line_total`（已含 `discount_total` 分摊）；运费**不随缺货单自动退**，按门店运费只有 `courier_quote_snapshot.groups[].shipping_fee_fen` 快照，整组商品全缺时才可按该快照退运费，否则不摊派。

## 3. 明确缺口清单
- 无 shortage↔after_sale↔refund 关联列；无服务端金额来源约束。
- 无客户身份的退款执行路径（roles 硬校验）。
- 无业务短信模板/回执/重试 outbox。
- 无消费者侧自助售后创建（仅客服提示），且 `commerce_create_after_sale` 按 `user_id` 而非 `customer_id` 判定归属。
- 无手工快递单写入与发货事务。
- 无 shortage 操作审计表。
