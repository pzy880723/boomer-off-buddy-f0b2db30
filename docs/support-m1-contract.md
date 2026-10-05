# 客服 M1 后端契约（2026-10-05）

迁移：`drizzle/migrations/0033_support_assignment_m1.sql`（已应用到 Lovable Cloud；腾讯由 Codex 部署）。

## 数据库
- `support_conversations` 新增：`channel`(native|wechat_kf，默认 native)、`primary_agent_id`、`assignment_version`(默认0)、`escalated_at`、`escalation_reason`(unclaimed_timeout|reply_timeout)、`waiting_since`。
- `support_messages` 新增：`delivery_status`(sent|pending|failed，默认 sent)、`assignment_version`。wechat_kf 对外消息一律 `pending`，未接入微信外发前绝不显示已发送。
- 触发器 `trg_support_waiting`：客户首条消息设置 `waiting_since`（连发不重置）；仅主接待人有效对外回复清零并解除升级。
- RPC（仅 service_role）：`support_update_assignment(conv, actor, action, expected_version)`、`support_staff_post_message(...)`、`support_escalate_overdue(60,180)`、`support_actor_can_access(actor, location, require_hq)`。授权由 user_roles / support_agents / user_location_perms 在库内推导。

## ServerFn（网页）
- `listSupportConversationsFn` → `{items, scope, agent:{id,name,role}}`；每个 item 带 `primary_agent_id/name, assignment_version, channel, escalated_at, escalation_reason, waiting_since, context_key, context, can_reply, can_note, can_claim, can_takeover, can_close, can_reopen`。
- `getSupportConversationFn {conversationId}` → `{conversation(同上扩展), messages[+delivery_status], can_reply, can_note}`。
- `sendSupportMessageFn {conversationId, body, internal, clientOpId, assignmentVersion?}`：对外回复缺版本 → `assignment_version_required`。
- `updateSupportAssignmentFn {conversationId, action:'claim'|'takeover'|'close'|'reopen', assignmentVersion}`。
- `runSupportEscalationFn`（super_admin/hq_operator）。
- 错误：抛出 `"[code] 中文说明"`，code 见 `src/lib/support-policy.ts` `SUPPORT_ERRORS`。

## 手持 / 商城 HTTP（与 ServerFn 字段一致，snake_case）
- `POST /api/public/handheld/support/conversations/{id}` 新增 `assignment_version`；非 internal 无版本 → 409 `assignment_version_required`，非主接待人 → 403 `not_primary_agent`，版本冲突 → 409 `version_conflict`（附当前 `assignment_version`、`primary_agent_id`）。
- 新增 `POST /api/public/handheld/support/conversations/{id}/assignment` `{action, assignment_version}`。
- `POST /api/public/storefront/support/conversations` 新增 `product_id`；订单须属于登录顾客，门店由订单行（跨店→总部 null）/商品派生；`location_id` 仅用于一般咨询；返回 `{conversation_id, reused}`。context_key：`order:<id>` / `product:<id>` / `general:<location>` / `general`。

## 差异与限制
- 旧手持客户端对外回复将被 409 拒绝，需更新为「先领取 → 带版本发送」；内部备注不受影响。
- 关闭后禁止对外回复，内部备注仍可写。
- 超时升级不自动运行：腾讯用 systemd timer 每 15–30 秒执行 `node scripts/run-support-escalation.mjs`。
- 未做：微信客服真实收发/验签/凭证、AI 回复、实时推送、任何资产/支付/退款变更。
