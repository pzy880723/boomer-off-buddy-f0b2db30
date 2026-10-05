# 客服方案：只读核查结果与落地路线

核查时间：2026-10-05 12:36 UTC。这次只做了读取：没改代码、没跑迁移、没设密钥，也没给客户发消息。腾讯还没有部署任何客服功能。

## 一、现在已经有什么（只读证据）

**5 张表**（RLS 全部开启，策略只有 `ALL TO service_role`，anon/authenticated 没有表级授权，也没有任何触发器）

| 表 | 关键字段 | 唯一键 / 约束 |
|---|---|---|
| support_conversations | location_id→inv_locations, customer_id→commerce_customers, order_id→commerce_orders, topic, status(open/pending/closed), context_key, context jsonb, last_message_at/preview | 部分唯一 (customer_id, context_key)，仅 open/pending 时生效 |
| support_messages | sender_type(customer/staff/system), sender_user_id, sender_customer_id, body, internal, client_op_id | 部分唯一 (conversation_id, client_op_id)；CHECK：只有员工能发内部备注 |
| support_participants | conversation_id, user_id, participant_role(store_staff/hq_agent), last_read_at | UNIQUE (conversation_id, user_id) |
| support_agents | user_id, scope(hq/location), location_id, is_active | UNIQUE (user_id, scope, location_id) |
| support_customer_reads | conversation_id, customer_id, last_read_at | PK (conversation_id, customer_id) |

数据量：会话 3 条 / 消息 4 条 / 客服登记 0 条。

**上下文**：有顾客和订单的外键，商品只能放在 `context` jsonb 里，没有 SKU/商品外键。
**身份**：`commerce_customer_identities(customer_id, provider, provider_subject)` 可以登记微信 openid/unionid、企业微信外部联系人 ID；另有 `go_identity_links`（GO 用）。
**订单的门店拆单字段**：`commerce_orders.sale_location_id`（销售门店），`commerce_order_items.location_id`（逐件发货门店），`commerce_payment_suborders`（按收款主体分账，没有门店字段，门店信息只在 `allocation_snapshot` 里）。
**企业微信配置**：`app_settings` 里查了 wecom / work_weixin / corp / kf / wechat / weixin 等键名，**0 条**。代码中的 corpid/kf 只出现在门店二维码模块，没有接入企业微信接口。

**能复用的代码**
- `src/server/support.server.ts`：resolveSupportAccess、staffCanAccessConversation、resolveConversationLocationFilter、list/get/postStaffMessage、ensure/get/postCustomerMessage（门店授权和总部看全部门店已经实现）。
- 后台 `src/lib/support.functions.ts` + 页面 `/customer-service`（列表/详情/内部备注，靠 10–15 秒轮询刷新）。
- 手持：`/api/public/handheld/support/conversations[/$id]`；小程序/商城：`/api/public/storefront/support/conversations[/$id]`。
- 可以照搬的模式：有赞收件箱的验签 + 去重 + 租约（youzan_member_asset_inbox），外发 outbox 的 claim/finish 写法（handheld_*_outbox），以及 `youzanFetch` 那种固定出口代理。

## 二、缺口

1. 没有主接待人字段（会话上没有 owner_user_id / 状态机），总部"接管"只能靠多加一个参与人，没有明确的交接记录。
2. 没有渠道维度：会话和消息都不记录来源（小程序 / 微信客服 / APP），也没有外部消息 ID（msgid）去重。
3. 没有回调收件箱和同步游标：微信客服 `kf/sync_msg` 要求保存 next_cursor 和事件 token，现在没有对应的表。
4. 没有外发 outbox：员工回复不能可靠送到微信客服（48 小时窗口、最多 5 条、失败要重试），也没有发送状态。
5. 没有超时任务：没有"门店 N 分钟没回复就升级到总部"的计时和调度。
6. `support_agents` 是 0 行，现在全靠角色兜底判断权限。
7. 企业微信 corp_id、客服 secret、回调 Token/EncodingAESKey 都没有配置，渠道身份也没有绑定数据。
8. 消息只有纯文本，不支持图片、商品卡片和订单卡片。
9. 没有实时推送，靠轮询。APP 原生聊天之后要用 Realtime 或长轮询。

## 三、建议落地路线（等你批准后分阶段做）

```text
顾客: 小程序客服按钮 / 微信客服链接 / APP
        │
        ▼
 企业微信「微信客服」(总部统一主体) ──回调──► 腾讯 ERP 收件箱(验签+msgid去重+游标)
                                              │
                                              ▼
                               support_conversations (门店优先分配)
                                  │ 超时/门店无人 → 总部接管同一会话
                                  ▼
                               员工回复 → 外发 outbox → kf/send_msg (固定出口)
```

- **阶段 1（只动数据库）**：会话加上 channel、owner_user_id、assigned_location_id、escalated_at、sla_due_at；消息加上 channel、external_msg_id（唯一）、msg_type、payload；新建渠道身份绑定表（或扩展 commerce_customer_identities）、support_channel_inbox、support_channel_cursors、support_outbox，全部只允许 service_role 访问。
- **阶段 2**：企业微信回调接口 `/api/public/hooks/wecom-kf`（先验签、解密，再落库，有赞那套校验模式照搬过来）+ 定时拉取 sync_msg 的任务 + 外发任务。门店分配规则：先看订单的 sale_location_id，再看扫码来源门店，最后落到总部队列。
- **阶段 3**：后台工作台增加"接待人 / 接管 / 转回门店"和商品、订单卡片；小程序加 open-type=contact 或微信客服链接；APP 走 storefront 接口 + 实时推送。
- **阶段 4**：超时升级任务、满意度、对账报表。

## 需要你提供 / 确认

- 企业微信主体（总部统一）的 corp_id 和微信客服 secret。在项目设置的密钥里添加，不要发在聊天里。
- 门店超时升级的分钟数，以及总部接管后是否允许门店继续回复（建议允许，并显示主接待人）。
- 回调和外发都部署在腾讯（erp.boomeroff.com），并走固定出口 IP 白名单。

## 技术附注：只读查询
- `information_schema.columns where table_name like 'support_%'`
- 对 `support_%` 查询 `pg_constraint` / `pg_indexes` / `pg_policies` / `information_schema.triggers` / `pg_class.relrowsecurity` / `role_table_grants`
- `select key from app_settings where key ilike any('%wecom%','%work_weixin%','%corp%','%kf%','%wechat%','%weixin%')` → 0 行，没有读取任何值
- 对 commerce_orders / commerce_order_items / commerce_payment_suborders / commerce_customer_identities 查询 `information_schema.columns`
