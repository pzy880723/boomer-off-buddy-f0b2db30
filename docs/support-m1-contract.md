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

## 0034 补丁（2026-10-05，增量，不改 0033）
- 0033 和 0034 都是 Lovable Cloud 内嵌库的迁移（数据库 `postgres`，表和函数的 owner 都是 `postgres`），不是另建的腾讯数据库；腾讯库由 Codex 按同一份 SQL 部署。
- wechat_kf 对外回复返回 `channel_not_connected`（409），不再插入 pending 消息；内部备注照常可写；`can_reply` 在非 native 渠道一律为 false。历史 pending 消息保留，不补发（当前 0 条）。
- 关闭 / 重开：只有主接待人或总部可以操作，未领取的会话只有总部能操作，否则返回 `primary_or_hq_only`（403）；`supportCapabilities.can_close/can_reopen` 与此一致。接管始终以登录者本人身份执行。
- 现有触发器 `trg_support_conversation_touch` 已重写：只有公开且已发送的消息才更新 `last_message_preview/last_message_at`；时间更早的消息不会覆盖更新的预览；内部备注只更新 `updated_at`，不再清空或泄漏顾客看到的预览。
- 幂等：同一 client_op_id 但 body / internal / 发送者不同，返回 `client_op_id_conflict`。
- 顾客发送改走 `support_customer_post_message`（行锁事务）：会话关闭后不能再插入新消息；同一 op 但内容不同也返回冲突。商城接口的错误码改为与业务码对应的状态码（不再一律 404）。
- 商品上下文：只接受 `published` 状态的商品；context 只存/返回 type、id、title、price、order_no、sku_code，去掉 image_url 和 cover_url（历史会话的 image_url 在输出时剔除）。
- `run-support-escalation.mjs`：15 秒超时（AbortSignal.timeout）；阈值必须是 10–3600 的整数；会校验响应格式；只输出 `{escalated, checked_at}`，不打印会话 id 和原始错误内容。

## 队列与分页（2026-10-05 14:xx，无迁移）
- 生产服务的 SUPABASE_URL 指向 Lovable 内嵌库；0001–0034 都已应用在这个库上，不需要在腾讯重复执行，也不另建腾讯数据库。
- 会话列表新增 `queue = unclaimed | mine | escalated | closed | all`，不传时默认 `all`，兼容旧客户端。队列筛选、门店范围、游标都在数据库里、在 limit 之前执行。
  - unclaimed：open/pending 且未领取
  - mine：open/pending 且主接待人是登录者本人（用服务端拿到的登录 ID）
  - escalated：open/pending 且已升级
  - closed：已关闭
- 排序固定为 `updated_at desc, id desc`。`next_cursor` 是 `"<updated_at>|<id>"` 不透明字符串，原样传回即可；同一 updated_at 的会话不会被漏掉。游标非法时返回 400 `invalid_cursor`。
- 网页 ServerFn：`listSupportConversationsFn({queue?, cursor?, limit?})`（limit 1–100，默认 50），不传参数也能用；返回值新增 `next_cursor`、`queue`。
- 手持：`GET /api/public/handheld/support/conversations?queue=&cursor=&limit=&location_id=&status=`，返回值新增 `queue`。
- 会话详情（员工和顾客两端）只返回最近 500 条消息，按时间正序排列，并带 `has_more`。`has_more=true` 表示还有更早的消息没返回，这一版不提供完整历史。
- 回填核查：未关闭会话中，waiting_since 为空、但最后一条顾客公开消息晚于最后一条员工公开消息的，数量为 0，所以不需要回填迁移。

## 头像与发言身份（2026-10-05，无迁移）
- 每条消息保留所有旧字段，新增 `sender_avatar_url: string|null`、`sender_role: customer|store_staff|hq_agent|system`、`sender_location_name: string|null`。员工 ServerFn、handheld GET/POST 和 storefront GET/POST 共享同一消息投影，POST 的 `message` 与再次 GET 一致。
- 员工列表/详情 conversation 新增 `customer_avatar_url: string|null`，复用所属 `commerce_customers.avatar_url`。客户消息只有 sender_customer_id 匹配会话 customer_id 才加载头像，不借用其他客户头像。
- 门店字段核查：`inv_locations` 无头像字段，但 `shop_id` 关联 `youzan_shops.id`，后者已有 `image_url`。按当前授权会话门店关联加载该图片；如果为私桶对象 key、签名 URL 或缺图，则返回 null，绝不生成签名或读取原图。`inv_brands.logo_url` 是品牌图片，不作门店头像。
- 历史员工按消息 `sender_user_id` + 该会话 `support_participants.participant_role` 区分，绝不用当前 primary_agent_id 替代。缺失/未知历史 participant 采用 system/null 保守回退，不猜测身份。
- HQ 仅使用服务端管理的 `app_metadata.avatar_url`（通过认证管理读取）；当前未发现已验证个人头像生产者，不信任可自行修改的 user_metadata.avatar_url，未配置默认 null。不新增头像配置入口。
- 安全 HTTPS 公开 URL 采用保守白名单规则：拒绝所有查询参数、片段、凭据、非标准端口、IP/本地主机、签名/私有路径、相对对象 key；不发网络请求或签名。UI 加载失败仍需默认头像回退。
- GET 在会话授权后才查头像；POST 在数据库事务成功后重新核对会话授权再加载头像。顾客只看公开 sent 消息，员工 sender_name 使用门店/总部/系统安全称谓，不返回员工 ID、邮箱或原始 metadata。
- 本轮无数据库/权限/迁移修改、无真实客户写入、无 UI 修改、无微信外发或腾讯部署。0001–0034 不需要在腾讯重复执行。
