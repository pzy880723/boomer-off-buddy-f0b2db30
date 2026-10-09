# iPhone App Store 首发前只读核查结果（不改代码、不部署）

工作副本 HEAD：`50d4c49b9b842ac73da92b81d80d60382a80940d`（GitHub main 已知为 88549ad5，以 Codex 本地核对为准）。

## 1) AI 出站路径
所有 AI 调用都只发往 `https://ai.gateway.lovable.dev/v1`（Lovable AI 网关），代码里没有直连 OpenAI 或 Google 的地址。模型 ID 显示的上游厂商是 Google Gemini 和 OpenAI。
- 拍照识别：`src/server/product-recognition.server.ts:340`（gemini-2.5-pro/flash），`src/server/product-title.server.ts:11`（gemini-2.5-flash，可用 env HANDHELD_PRODUCT_RECOGNITION_MODEL 覆盖），`src/lib/mobile.functions.ts:353`
- 图片修整：`src/server/handheld-ai.server.ts:9/148`（gemini-3.1-flash-image），成品复核在 `src/server/listing-image-safety.server.ts:99,117`（gemini-2.5-flash），`src/lib/sku-image.functions.ts:16`（gemini-2.5-flash-image）
- 文案：`src/server/listing-summary.server.ts:78`、`src/server/recommendation-card.server.ts:132`、`src/server/custom-print-cards-ai.server.ts:69`（openai/gpt-6-astra，走 /responses），`src/server/product-content.server.ts:85`、`src/server/handheld-editorial.server.ts:4`
- 其他 AI 路径（多数只在后台网页使用）：`src/lib/ai.functions.ts`、`recognize.functions.ts`、`meruki-parse.functions.ts`、`domestic-recognize.functions.ts`、`tariff.functions.ts`、`translate.functions.ts`、`pack-pieces.functions.ts`，以及两个 `handheld/parcels.items.$itemId.pack-pieces.estimate-*` 接口
- 其他非 AI 第三方：腾讯云短信 `src/server/sms.tencent.server.ts:5`；有赞（经固定出口代理）
- 需要业务确认：网关及上游厂商的数据保留、是否用于训练、处理所在地区，代码里都看不出来。工作区当前的保留政策里，Google/OpenAI 在 chat/responses 上未列为允许保留，但这只是工作区设置，不能代替合同条款。

## 2) 数据存放位置
- 业务数据库与登录：原 Lovable Cloud 数据库（`tencent-media-client.server.ts` 注释写明"主业务库 + auth 仍在 Lovable"）。旧腾讯 Web 也连这个库（之前已只读核实）。
- 原图：存储桶 `sku-raw`。处理图：`sku-listing`（`ai.prepare-listing-image.ts:29`，签名链接 7 天有效，但文件本身没有删除逻辑）。另有桶 `shop-images`、`transfer-receipts`、`domestic-order-screenshots`、`domestic-bulk-attachments`。包裹商品图会写到腾讯 COS 背后的存储 `parcel-item-images`（公开桶，`src/server/tencent-media-client.server.ts`）。
- 员工设备 install_id 和设备名：表 `inv_handheld_devices`，按 (owner_user_id, install_id) 写入或更新（`src/routes/api/public/handheld/auth.bootstrap.ts:66-110`）。
- 客服文字：表 `support_messages` / `support_conversations`（规则见 `src/server/AGENTS.md`）。
- 扫码支付：`pos_payment_attempts`（qr_content、code_url、expires_at，`src/server/pos-payment.server.ts:54,349`）；线上支付在 `commerce_payments`，其中 payment_payload 在 `src/routes/api/public/storefront/payments.ts`。
- 订单与审计：`commerce_orders`、`commerce_order_items`，以及多张 `*_audit` / `*_audit_logs` 表。
- 删除与保留规则：代码里没有找到针对上述数据的定期清理或删除任务。expires_at 只控制有效期，到期后不删数据。实际保留多久、有没有备份（腾讯备份脚本 `infra/tencent-supabase/ops/backup.sh` 的范围未核实）都需要业务确认。不能说成"不保留"。

## 3) 公开支持页 / 隐私页
`src/routes` 里没有 privacy、support、terms、contact 页面，代码里也没找到公司客服邮箱或电话。目前不存在可公开的 ERP 隐私或支持页面，真实公司联系方式需要业务提供。

## 4) 审核 / 演示门店与最小权限账号
- 已有的权限能力：角色枚举 `app_role`（super_admin / hq_operator / store_manager / store_staff / warehouse_staff），存在 `user_roles`；门店隔离靠 `user_location_perms`（`src/server/handheld-auth.server.ts:177,249`）；后台账号管理在 `src/lib/admin-users.functions.ts`、`src/routes/admin.users.tsx`。
- 没有找到专门隔离的审核或演示门店、演示数据开关或审核账号机制。技术上可以用"单独门店 + store_staff + 只授权该门店"组合出来，但可能会影响有赞同步、库存和报表，需要业务确认；本轮没有创建任何东西。

## 待业务确认
1. Lovable AI 网关和 Google/OpenAI 的数据保留、训练用途和处理地区条款
2. 生产数据库归属（Lovable Cloud 还是腾讯）以及它在哪个地区
3. 各类数据的保留期限、删除流程和备份范围
4. 公开隐私政策和支持页面的托管地址，以及公司对外联系渠道
5. 审核演示门店是否建立，以及怎样与有赞、报表隔离
