# 只读核查结果与最小方案：尺寸申请改走客户服务（2026-10-18）

本次没有改代码、数据库或线上，也没有发通知、建任务。以下内容来自 Lovable 预览源码和共享库，不代表腾讯正式版 product-marks-sync-20261018。

## 1. 现在的写入情况
- 顾客申请：`src/routes/api/public/storefront/products.$id.measurement-requests.ts` → `requestMeasurementProduction`（`src/server/product-measurement-production.server.ts`）→ RPC `measurement_request`。
  - 写 `product_measurement_tasks`：每个 SKU 最多一个进行中任务，状态为 pending/claimed。
  - 写 `product_measurement_requesters`：按 (task_id, customer_id) 去重。
  - 只在首次创建任务时写 `inv_handheld_notifications`：kind=`measurement_requested`，按门店 location_id 发送，user_id 为空，所以门店里所有员工都能看到。ref_type=`measurement_task`，payload 含 sku_id、listing_id、product_name。
  - 不创建 `support_conversations` 或 `support_messages`，也没有模板卡片。
- 保存尺寸：RPC `measurement_save`（手持端和 PC 的 `/inventory/measurements` 都调用它）。
  - 写入 SKU 尺寸并更新 revision，完成任务。
  - 写 `commerce_customer_notifications`：kind=`measurement_completed`，product_id=listing_id，dedupe_key=`measurement:{task}:{customer}`。这是顾客端通知，不是内部消息。
  - 回填 requesters.notified_at。
  - 不写入任何客服会话。

## 2. 客服会话
- `support_conversations` 没有 product_id 列，商品放在 context/context_key 里。门店由服务端根据订单或商品推断；只有一般咨询才用 location_id；location_id 为空就归总部通用咨询。
- 尺寸申请目前完全不经过客服会话，因此不会出现在“待接待”里。

## 3. 角标与首页待办现在的规则
- RPC `handheld_unread_counts`（由 `notifications.unread-counts.ts` 调用）：
  - customers：统计晚于本人 `support_participants.last_read_at` 的顾客消息条数。它按消息计数，不按会话计数，也就是已读状态，不是待处理状态。
  - internal/orders/system：按 `handheld_notification_category(kind)` 分类，统计本人未读的手持通知。
  - `measurement_*` 会被分到 **internal**，所以尺寸申请目前算在公司内部消息里，和你要的不一致。
- 首页待办（`src/routes/api/public/handheld/dashboard.ts`）只包含调拨、盘点、履约和尺寸任务，**没有“待回复客户会话”**。同一个尺寸任务会同时算进待办和通知 internal 未读，存在重复计数。

## 4. 当前数据（只统计数量，不含任何隐私）
- 尺寸任务：pending 2；申请人记录 2；`measurement_requested` 内部通知 2，两条都已有已读记录。
- `commerce_customer_notifications` 里没有 measurement_completed。
- 客服会话：open 5，其中 waiting_since 不为空 2，location 为空（总部）2。

## 5. 最小方案（等你授权后才实施）
1. 申请时改为在同一事务里，找到或创建该商品的客服会话：context_key=`product:{listing}`，门店规则与商品咨询相同。追加一条固定的系统卡片消息 `kind=measurement_request`，内容为 task_id、listing_id、图片路径、品名，不带顾客正文。同时设置 waiting_since。**不再写** `inv_handheld_notifications`。
2. ERP 客户通知和手持会话中显示这张卡片，点击后打开现有的尺寸填写表单（复用 `measurement_save`）。首页待办加入“待回复会话”，入口仍然是这个会话。
3. 区分两种计数：
   - 未读：按会话里的消息与已读时间计算，打开会话即清除。
   - 待处理：去重后的集合，即进行中尺寸任务所在的会话加上 waiting_since 不为空的会话，按会话 id 和任务 id 去重。角标显示待处理数量。尺寸任务不再计入 internal。
4. 状态怎么变：
   - 读过：只清未读，待处理不变。
   - 员工回复：清掉 waiting_since。如果尺寸任务还没完成，仍算待处理。
   - 顾客再次回复：重新设置 waiting_since，未读加 1。
   - 保存尺寸：任务完成，在会话里写入“尺寸已更新”的卡片，并保留现有的 `commerce_customer_notifications` 顾客通知。尺寸部分不再算待处理；会话里有没有其他待回复，仍由 waiting_since 决定。
5. 隔离：门店和账号范围沿用 `resolveNotificationScope`、`user_location_perms` 和总部规则，所有接口都在服务端校验。迁移只做增量，旧的 `measurement_requested` 通知保留为历史，不改动。
6. 测试：每条规则一个测试，包括重复申请只有一张卡片、读过不算处理完成、保存后待处理减 1、跨门店看不到。

腾讯部署另由 Codex 验收，本方案暂不部署。
