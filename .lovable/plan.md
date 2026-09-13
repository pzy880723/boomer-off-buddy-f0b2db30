# 消费者账号合并前只读核查（内嵌 Supabase）

本轮仅执行只读 SQL，未修改任何代码、数据、权限，未部署腾讯。

## 1. 两个账号在本库的映射

| 外部 consumer id（腾讯） | 本库 commerce_customers.id | 状态 | 创建 | 最近登录 | 手机号 | 微信 openid/unionid |
| --- | --- | --- | --- | --- | --- | --- |
| a615b209…86d4（旧手机号） | b782a331-a938-4156-b826-bc4c3ce6c664 | active | 2026-08-17 | 2026-09-08 | 有 | 无 / 无 |
| 6aedbea1…f149（微信，保留） | 1b9676d9-1cf8-4e83-bc9e-323abfd9293c | active | 2026-09-08 | 2026-09-13 | 无 | 无 / 无 |

映射列为 `commerce_customers.external_subject`（UNIQUE），本库其余表一律引用内部 `commerce_customers.id`，不存储外部 consumer id。

## 2. 每账号每表关联条数（实查，仅计数）

| 表（列） | 旧手机号 b782a331 | 微信 1b9676d9 |
| --- | --- | --- |
| commerce_orders (customer_id / user_id) | 0 / 0 | 3 / 3 |
| commerce_customer_identities (customer_id) | 1（provider=phone） | 0 |
| commerce_membership_orders (customer_id) | 1（status=created，2026-08-21） | 0 |
| commerce_recognition_usage_daily (customer_id) | 1（2026-08-18） | 0 |
| commerce_recognition_usage_requests (customer_id) | 1（status=reserved） | 0 |
| support_conversations / support_customer_reads / support_messages(sender) | 0 / 0 / 0 | 3 / 2 / 1 |
| commerce_membership_entitlements、commerce_points_ledger、commerce_consumption_records、commerce_member_code_sessions、commerce_membership_admin_audit_logs、pos_customer_coupons、pos_customer_wallets、pos_held_carts、pos_payment_attempts、commerce_after_sales(user_id) | 0 | 0 |

订单明细（微信账号 3 单）：
- BO20260913100009 — processing / paid / paid_at 2026-09-13 02:24:43Z
- BO20260913100008 — cancelled / unpaid
- BO20260909100007 — cancelled / unpaid

旧手机号账号订单数为 0。

## 3. JSON 引用扫描

对 `orders.metadata`、`orders.payment_route`、`orders.benefit_snapshot`、`payments.payment_payload`、`payments.merchant_snapshot`、`payment_events.payload`、`membership_orders.provider_payload`、`points_ledger.metadata`、`pos_payment_attempts.sale_payload`、`aigc_sso_tickets.user_id` 逐一 LIKE 扫描 4 个 id 字符串：

- 命中仅两处，且都指向**微信账号内部 id**：`commerce_orders.payment_route` 3 行、`commerce_payments.merchant_snapshot` 3 行。
- 两个**外部 consumer id** 在所有被扫 JSON 列中命中 0 次。
- 旧手机号内部 id 在所有被扫 JSON 列中命中 0 次。

## 4. 唯一键与外键（决定合并安全性）

- `commerce_customers`：PK(id)、UNIQUE(external_subject)、CHECK status ∈ active/blocked/deleted。
- `commerce_customer_identities`：UNIQUE(provider, provider_subject)、FK customer_id → customers ON DELETE CASCADE、CHECK provider ∈ phone/wechat。
- 引用 customers(id) 的外键共 16 个；其中 RESTRICT：`commerce_membership_orders`、`commerce_points_ledger`、`commerce_consumption_records`、`commerce_membership_admin_audit_logs`；`commerce_orders` 无级联动作；其余多为 CASCADE，`support_messages.sender_customer_id` 为 SET NULL。

关键含义：旧手机号账号有 1 条 RESTRICT 引用（membership_orders），**不能直接删除该客户行**；必须先改指或保留该行。

## 5. 结论

1. **保留微信 ID 完全安全**：今天已付款订单 BO20260913100009 及其支付快照全部挂在 `1b9676d9…` 上，只要不动这一行和其 `external_subject`，订单、支付、客服会话零变更。
2. **旧手机号 ID 在 ERP 侧几乎没有必须迁移的资产**：无订单、无支付、无客服、无会员权益、无积分、无优惠券、无钱包。仅 3 类轻量记录：1 条 `status=created` 的会员订单（未完成）、1 条识别用量日计数、1 条 `reserved` 识别配额请求，以及 1 条 phone identity 行。
3. 因此 409 冲突的根因在腾讯 consumer 侧的手机号唯一约束，本库不构成阻碍。

## 6. 安全合并建议（待批准后再单独立项执行，本轮不写入）

在腾讯 consumer 侧把手机号挂到保留的 `6aedbea1…f149` 之后，本库只需一次小事务：

1. 在 `commerce_customer_identities` 把旧账号的 phone identity 行 `customer_id` 改指 `1b9676d9…`（UNIQUE(provider,provider_subject) 不冲突，因为保留账号当前无 phone identity）。
2. `commerce_customers` 中保留账号补写 phone 字段（值由腾讯侧为准）。
3. 三条轻量记录处理二选一：
   - 最小风险：保持原样不迁移（它们不影响下单与支付，识别配额会按新账号重新计数）；
   - 若要求归口统一：把 `commerce_membership_orders`、`commerce_recognition_usage_daily`、`commerce_recognition_usage_requests` 这 3 行 `customer_id` 改指保留账号，注意 `recognition_usage_daily` 可能存在 (customer_id, usage_date) 唯一键，需先查再决定 UPDATE 或丢弃。
4. 旧客户行不要 DELETE（RESTRICT 外键 + 审计可追溯性），建议仅将 `status` 置为 `deleted` 并清空 `external_subject` 之外的可识别字段，且该动作需单独授权。
5. 全程不触碰 `commerce_orders`、`commerce_payments`、`payment_route`、`merchant_snapshot`，避免影响已付款订单与对账。

执行前建议先在腾讯生产库以同样 SQL 复核计数（本轮结果来自 Lovable 内嵌库），两库计数不一致时以腾讯为准。
