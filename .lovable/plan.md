# ERP 多渠道销售 v1：只读审计结论与契约方案

## 1. 当前真实状态（Lovable Cloud 只读查询结果）

| 对象 | 实际情况 |
|---|---|
| `commerce_listings` | 每个 (sku_id, location_id) 唯一。共 96 published / 3 hidden / 7 sold / 5 archived。小程序和 APP 共用这一张表，**没有区分渠道的字段**。另有 `readiness_hold`、`pending_display` 字段（0112–0115 展示门禁） |
| `sku_channel_listings` | 有赞专用：`youzan_branch_offline` 有 1445 条 published、6 unshelved、1 delisted、1 error；`youzan_hq` 有 403 条 unshelved。字段有 `listing_status`、`verified_inventory_version` |
| `channel_sync_outbox` | 只有 `delist` / `set_stock_zero` 两种动作（共 16 条，状态 succeeded 或 superseded）。由 `hooks/channel-sync-worker.ts` 领取任务，动作执行前会重新读取版本和库存 |
| `inv_stocks` | 字段 `sku_id, location_id, qty`。切换渠道不涉及这张表 |
| `commerce_orders` | 有 `source_channel`、`sale_location_id`。来源审计表 `commerce_order_origin_audit` |
| 消费端登录 | `storefront-auth.server.ts`。会话中有 `wechatMiniOpenId` / `wechatMiniAppId`。身份表 `commerce_customer_identities` 目前只有 `phone` 10 条 |
| 订单来源 | `order-origin.server.ts` 的 platform 取值为 `miniapp/app/web`，证据默认是 `client_reported`，也就是客户端自己报的 |
| 消费端读取 | `storefront/products.ts` 和 `products.$id.ts` 只用 `status='published'` 加门禁过滤，没有按渠道过滤 |
| 手机接口 | `handheld/items.$id.*` 下目前没有 sales-channels 相关接口 |

结论有三点：
- 只有有赞的"平台实际状态"有数据表；小程序和 APP 目前既没有"用户选了哪个渠道"的记录，也没有分开的平台状态。
- 消费端渠道不能靠客户端自报的 header 判断。

## 2. 消费端渠道的识别规则（服务端判断）
- **miniapp**：会话中有服务端换码得到的 `wechatMiniAppId`，且该值等于配置的官方小程序 appid。
- **app**：会话没有 mini appid，并且是通过 APP 登录方式（手机号或 Apple）签发的。v1 在签发会话时写入 `client_kind`，写在服务端签名的 claim 里，客户端改不了。
- 旧会话里没有 `client_kind` 的：如果有 mini appid，就按 miniapp 处理；否则按 app 处理。日志中标记为 `inferred`。
- 任何 header 都只作为参考提示，不作为判断依据。

## 3. 最小迁移 0117（只新增表、视图和函数，不回填真实铺货）

```sql
CREATE TABLE public.sku_sales_channel_intents (
  sku_id uuid NOT NULL, location_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('miniapp','app','youzan')),
  enabled boolean NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_by uuid, op_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, location_id, channel));
CREATE TABLE public.sku_sales_channel_ops (op_id uuid PRIMARY KEY, actor uuid, location_id uuid,
  request jsonb, result jsonb, created_at timestamptz DEFAULT now());
GRANT ALL ON both TO service_role;   -- 不授予 anon 和 authenticated
ENABLE RLS（不建策略）
```
- **没有意图记录就保持现状**：小程序和 APP 都视为开启，跟今天一样；有赞以 `sku_channel_listings` 为准。所以现有商品不需要回填，也不会被批量上架或下架。
- 新增 `public.storefront_channel_visible(sku, location, channel)`（SECURITY DEFINER，STABLE）：只有意图记录明确 `enabled=false` 时返回 false。
- 新增 `public.sales_channel_apply(p_actor, p_location, p_op_id, p_items jsonb)`（SECURITY DEFINER，只允许 service_role 执行）：
  - 在事务中逐条检查期望版本，不一致就返回 `version_conflict`。
  - 同一个 op_id 重复提交时，直接返回第一次的结果。
  - `commerce_listings.status` 为 sold 或 archived 的，拒绝重新开启，返回 `sold_locked`。
  - 不写库存、不写条码、不写 `commerce_listings.status`。
- 有赞开关只记录用户的意图。v1 **不新增有赞写任务**，有赞实际状态继续以 `sku_channel_listings` 为准。真正执行有赞发布或撤销，留到后续单独授权。

## 4. 接口契约（手持端，沿用现有 handheld 鉴权、库位和门店校验）
- `GET /api/public/handheld/items/:id/sales-channels?location_id=`
  返回 `{ sku_id, location_id, items_version, channels: [{ channel, selected, selection_source: 'explicit'|'default', version, platform_status, platform_source, blocked_reason }] }`
  - `platform_status` 的来源：
    - miniapp/app：`commerce_listings.status`，加上门禁结果，加上意图。
    - youzan：`sku_channel_listings.listing_status`。
- `POST /api/public/handheld/items/:id/sales-channels`
  请求 `{ location_id, op_id, changes: [{ channel, enabled, expected_version }] }`
  返回 `200 { applied, results[] }`；错误码为 `409 version_conflict`、`409 sold_locked`、`403 location_forbidden`。
- `POST .../sales-channels/batch-preview`
  请求 `{ location_id, scope: { sku_ids[] } | { select_all: { filters } }, add[], remove[] }`
  返回 `{ preview_token, total, eligible, skipped: [{ sku_id, reason }] }`，不做任何写入。
  - "全选本店"只覆盖在当前门店有明确库存记录、并且属于本店的商品。总部账号也一样要和当前门店求交集，跟批量修改的规则一致。
- `POST .../sales-channels/batch-apply`
  请求 `{ location_id, op_id, preview_token }`，只处理预览时确认过的那些行和版本。
- 角色权限只在服务端通过 `user_roles` 校验，门店范围沿用 `user_location_perms`。

## 5. 消费端在服务端执行
`storefront/products.ts`、`products.$id.ts`，以及下单路径 `commerce_create_ordinary_*` 前的检查（先在路由层做；RPC 加参数放在下一步），都按会话得出的 channel 调用 `storefront_channel_visible`。被关闭的商品：列表中不出现，详情返回 404，下单返回 `channel_disabled`。0112–0116 的门禁保持不变。

## 6. 测试与验收
- SQL 测试：
  - 没有意图记录时，小程序和 APP 可见性与现在一致。
  - 关闭后列表、详情、下单都被拒绝。
  - 版本冲突和 op_id 重复提交的处理正确。
  - sold 状态的商品不能重新开启。
  - 别的门店或总部没有当前门店库存记录时被排除。
  - 库存和条码前后对比没有变化。
- 路由测试：伪造 header 不能改变识别出的渠道；mini appid 正确识别为小程序。
- 不调用有赞写接口，不操作真实商品。

## 7. 与腾讯的差异和分工
- 腾讯需要窄合并：新增的 4 个 handheld 路由、storefront 读取的过滤、会话中的 `client_kind`。0117 已在共享的 Lovable Cloud 应用后，腾讯不要重复执行迁移。
- 原生两端由 Codex 负责：单件开关、批量预览和应用、显示平台实际状态。
- 后台订单提醒保持现状；不自动打印、不接面单。抠图、模型、提示词、依赖和既有调用路径都不改。

## 待确认
1. 有赞开关在 v1 只记录意图、不执行写入，是否同意？
2. 小程序 appid 是否就用现有登录配置里的那个？
