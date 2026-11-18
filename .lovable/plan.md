# 销售渠道协议只读核对结果（无需实施）

本次只读，没有改代码、数据库、配置，没有发布，没有发有赞请求，也没有部署腾讯。仓库 HEAD：`d86542c666a2fa9aa457ee6c6c23284bb13bc407`。

## 1. 接口已在本仓库实现
- `src/routes/api/public/handheld/items.$id.sales-channels.ts`：GET/POST `items/{sku_id}/sales-channels?location_id=`（最近一次提交 `a4fca23a`）
- `src/routes/api/public/handheld/sales-channels.batch-preview.ts`：最多 100 个 SKU，add/remove
- `src/routes/api/public/handheld/sales-channels.batch-apply.ts`：参数 preview_token + op_id
- 共用逻辑：`src/server/sales-channels.server.ts`、`src/lib/sales-channels/model.ts`
- GET 返回 sku_id、location_id、can_manage、stock_quantity、channels。每个渠道返回 channel、label、selected、selection_source（explicit/default）、version、available、platform_status、blocked_reason、is_store_channel、verified_at，另外多出 can_enable、can_disable。这和 iPhone 的 ProductSalesChannels 字段一致。

## 2. 数据库（Lovable Cloud 源库，只读回读）
- 以下表都已存在且开启了行级权限：sku_sales_channel_intents、sku_sales_channel_ops、sku_sales_channel_previews（三张表 0 条策略，只有服务角色能读写）；sku_channel_listings、channel_sync_outbox（各 1 条策略）；commerce_listings。
- 以下函数都存在：sales_channel_apply、sales_channel_apply_preview、sales_channel_allowed、sales_channel_youzan_item_shared。它们以函数所有者权限执行，只给 postgres 和 service_role 执行权限。
- 这些只能证明 Lovable Cloud 源库的状态，不能说明腾讯主库已经应用了 0117–0119。

## 3. 认证与门店范围（authorizeSalesChannelStaff）
- 校验顺序：设备令牌 → 员工会话 → location_id 格式 → 角色从 user_roles 读。
- 总部角色可以看任一门店，其他角色必须在 user_location_perms 里有该门店授权；门店必须是启用中的门店（kind=shop）。
- can_manage 由管理角色决定。POST 没有管理权返回 403 role_forbidden；版本号 expected_version 用来防并发覆盖，op_id 和请求指纹用来保证重复提交不会重复执行。
- 错误码：401 device_unauthorized / session_required，400 location_required / invalid_id，403 location_forbidden，500 access_query_failed 或 channel_failed，所有错误都带中文 message 和 code。

## 4. 三种状态分开表示
- 销售选择：读 sku_sales_channel_intents，有记录时 selection_source=explicit。没有记录时按默认：小程序和 APP 默认开启；有赞默认开启的条件是该店映射状态为 published。
- 真实平台状态（platform_status）：
  - 小程序/APP 看 commerce_listings，可能是 not_listed、sold、archived、disabled、hidden、published；
  - 有赞看 sku_channel_listings（youzan_branch_offline）的 listing_status，没有映射时为 not_mapped。最近一次意图任务进行中显示 syncing，dead_letter 显示 error。
- 同步核查证据：verified_at 只有有赞渠道有值，取自 sku_channel_listings.last_verified_at，其他渠道为 null。

## 结论与缺口
- 本仓库已有该精确路由。iPhone 报“请检查网络”的泛化错误，最可能的原因是腾讯基址 `erp.boomeroff.com` 上没有这个路由（你说腾讯本地源码里没有），返回 404 或非 JSON，被客户端当成网络失败。这一点是推断，我无法观察腾讯现网。
- 如果要在腾讯恢复，需要 Codex 移植上面 5 个文件，并确认腾讯主库已应用 0117–0119 迁移。我不执行。
- 没有验证的部分：腾讯现网接口和数据库状态；iPhone 端如何映射错误。
