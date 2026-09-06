# ERP APP 首页操作迁移 + 统一消息：现状审计与最小可实施边界

只读审计完成。当前代码提交 `0d48ae9d877ab01953b7d817e502a1e1136d5088`，最新已应用迁移 `20260831213000_hello_kitty_specific_ip.sql`（异步图片任务表来自 `20260831190000_handheld_async_listing_images.sql`）。未修改任何代码、数据库或有赞数据。

## 1. 手持消息（notifications）

现有表 `inv_handheld_notifications` 字段：`id, device_id, location_id, kind, title, payload, ts`。

- 路由：`GET /api/public/handheld/notifications`、`GET .../notifications/since`、`POST .../notifications/read-all`。
- 过滤：只按“设备 + 库位 + 全局”在应用层过滤（`notifications.ts:23-27`、`notifications.since.ts:36-40`），**没有按员工（user_id/角色）过滤**。
- 已读：`notifications.read-all.ts` 只是回一个时间戳，**数据库没有任何已读状态**（文件头注释自述）。
- 缺失：按人分发、单条已读、未读计数、消息分类（履约/缺货/客服/系统）、消息与业务对象（订单/履约/会话）的关联字段。

## 2. 商城履约（commerce fulfillment）

已存在表：`fulfillments`、`fulfillment_items`、`fulfillment_scans`、`fulfillment_exceptions`、`packages`、`package_evidence`、`shipments`、`shipment_events`、`print_events`、`warehouse_totes`。

已存在 API：`fulfillments` 列表、详情、`claim`、`bind-tote`、`pick-scan`、`pick-complete`。

已存在 RPC：`fulfillment_claim_task`、`fulfillment_bind_tote`、`fulfillment_pick_scan`、`fulfillment_complete_pick`。

- `fulfillment_pick_scan` 支持 EPC/条码/SKU 码匹配、错货拦截（`wrong_item`）、`client_op_id` 幂等。
- `fulfillment_complete_pick` 要求所有行 `picked_qty = expected_qty`，**只要有一行缺货就无法完成，且没有缺货申报/客户确认路径**。
- `fulfillment_exceptions` 表结构存在（kind/status/evidence/resolution），但**没有任何 API 写入或读取它**。
- 出票：`fulfillments.code` 存在，但**没有“已付款自动按履约门店建单并出票”的触发器或队列**，也没有拣货小票内容接口；`src/server/handheld-print.server.ts` 只有 SKU 价签 payload，没有订单二维码/行项目/库位。
- 扫订单码进订单：**没有** order-code 解析路由（`pos/resolve-code.ts` 只服务收银）。
- 面单：`shipments`（tracking_no/label_payload/status）和 `print_events` 表存在，但**没有申请面单、保存快递单号、置为“待取件”的 API 或状态机**；`order-policy.ts` 的状态机也只到 `handed_over`。

## 3. 客服 / 客户双向沟通

数据库中**不存在任何会话、消息、参与者或客户确认表**（无 conversation/session/message/agent 表）。storefront 只有商品、订单、支付、会员相关路由。

因此：门店与总部客服共同接待、不独占领取、客户端确认缺货，**全部为 0，需要新建领域模型**。

## 4. 异步主图 worker

- 队列表 `inv_listing_image_jobs`（sku_id + source_bucket + source_path 唯一），worker 路由 `POST /api/public/hooks/listing-image-worker`，每分钟 cron 已注册。
- 只处理 `sku-raw` 桶入队的图，成功后把 `image_paths` 中的原图路径替换成 `sku-listing/...`，并维护 `inv_skus.image_processing_status`。
- 图片指令（`handheld-ai.server.ts:102-107`）只要求正方形、浅灰底、校正曝光，并**严禁改文字与瑕疵** —— 也就是说**当前不会清除价签**，与新需求冲突。
- worker 成功后**没有任何有赞/商城同步触发**（文件内无 `channel_sync_outbox` 写入），主图清洁完成不会自动推送渠道。
- 对外主图与内部原图**没有区分字段**（只有一个 `image_paths` 数组，处理完就地替换）。

## 最小可实施边界（建议分四个独立批次）

1. **统一消息 v1**：给 `inv_handheld_notifications` 增加 `user_id`、`audience`、`topic`、`ref_type/ref_id`，新增 `handheld_notification_reads`（notification_id + user_id）；改造三个现有路由做员工+门店过滤，新增单条已读与未读计数。不动履约与客服。
2. **订单出票与拣货闭环**：已付款订单按 `sale_location_id`/库存所在门店生成 `fulfillments`（服务端函数或 RPC，不做前端触发）；新增订单二维码解析路由、拣货小票 payload（订单号+二维码+标题/条码/数量/价格/库位）、`shortage` 申报写 `fulfillment_exceptions`；`fulfillment_complete_pick` 增加“存在未确认缺货则拒绝完成”的分支。
3. **面单与待取件**：新增申请面单 API 写 `shipments`（provider/tracking_no/label_payload）、`print_events` 记录，履约状态从 `packed` → `handover_ready`（对外文案“待取件”），不改 `handed_over` 语义，避免与现有 `order-policy` 冲突。
4. **客户会话（共享接待）**：新建 `support_conversations` + `support_messages` + `support_participants`（门店与 HQ 客服可同时在场，无独占 claim）、以及 `shortage_confirmations`（客户显式确认才解除履约阻塞）；storefront 侧新增读写会话与确认接口。

图片方面单独一条：把“清除外加价签、保留商品本体文字与真实瑕疵”写进图片指令，并在 `inv_skus` 上区分内部原图与对外主图（例如新增 `listing_image_paths`），只有清洁通过的版本才进入渠道同步，并在 worker 成功后写 `channel_sync_outbox`。

请确认这四个批次的优先级与第一批范围，我再按你的具体实现要求落地。
