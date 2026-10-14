# 宝藏团（总部限时限量特价团购）只读核查结果与最小方案

本轮只做了只读查询，没有改代码、数据库、线上或有赞。下面的计数都来自本轮真实查询（Lovable Cloud 库），不代表腾讯线上。

## 1. 核查事实

### 库存点（inv_locations）
- 总部候选只有一条：`f45dc754-…` kind=warehouse，name=总部仓库，is_active=true，shop_id=NULL（没有绑定有赞门店）。
- 门店 kind=shop：启用 3 家（中信泰富店、温州朔门古港店、新天地店），停用 2 家，都绑定了 shop_id。
- 总部仓库：inv_stocks 有 6 行，但 qty>0 的为 0 行；commerce_listings 引用它的为 0 条；user_location_perms 授权它的为 0 条。
- 结论：总部库存点**结构上存在，但目前没有可售库存、没有上架商品、也没有人员授权**。不拿任何门店顶替总部。

### 角色
- app_role 枚举：super_admin、hq_operator、store_manager、store_staff、warehouse_staff。
- user_roles 实际只有 4 个 super_admin，hq_operator 和 warehouse_staff 都是 0 人。

### 订单与商品表
- commerce_listings 字段：id, sku_id, location_id, epc, title, description, cover_url, image_urls, image_paths, price, compare_at_price, condition_grade, category, status, published_at, sold_at, product_type, created_by, created_at, updated_at。没有活动或团购字段。
- commerce_orders 已有 source_channel（storefront/pos）、fulfillment_method（shipping/carryout/pickup）、sale_location_id、metadata、discount_snapshot、benefit_snapshot、reservation_expires_at、payment_route、idempotency_key、provider_transaction_id。**没有 business_type 字段。**
- commerce_order_items 已有 unit_price、original_unit_price、discount_snapshot、settlement_snapshot、location_id、listing_id、sku_id、quantity 和各类快照字段。
- 现有订单：storefront 来源 cancelled/unpaid 2 单、closed/refunded 1 单；pos 来源 completed/paid 1 单。fulfillment_method：shipping 3 单、carryout 1 单。
- 库里没有名字带 campaign/groupbuy/promo/activity 的表，**也就是还没有活动数据结构**。

### 现有业务函数（只读确认存在）
- 下单：`commerce_create_ordinary_order(p_customer_id, p_idempotency_key, p_items jsonb, 收货信息, courier*, p_shipping_fee, p_quote_snapshot, p_customer_note, p_merchant_id, p_app_id, p_owned_location_ids uuid[])`；另有 `commerce_create_ordinary_pickup_order`、`commerce_create_order(_v2)`。
- 付款：`commerce_prepare_ordinary_payment`、`commerce_apply_ordinary_payment`、`commerce_mark_ordinary_order_paid`。
- 退款：`commerce_prepare_ordinary_refund`、`commerce_apply_ordinary_refund`、`commerce_settle_refund_intent`。
- 超时释放：`commerce_release_expired_reservations`，入口是 `src/routes/api/public/hooks/commerce-release-expired.ts`。
- 手动发货：`commerce_manual_ship_fulfillment(p_actor_user_id, p_location_id, p_fulfillment_id, p_provider, p_tracking_no, p_lines, p_idempotency_key[, p_carrier_label])`，调用方是 `src/server/handheld-fulfillment-actions.ts`。
- 相关文件：`src/routes/api/public/storefront/orders.ts`（结算入口，会把 paymentPolicy.ownedLocationIds 传进去）、`src/server/storefront-orders.server.ts`、`src/routes/orders.online.tsx`、`src/lib/commerce-operations.functions.ts`（listCommerceOrders）、`src/lib/commerce/online-order-presentation.ts`。
- Android 手持端：`src/routes/api/public/handheld/fulfillments*.ts`（列表/详情/领取/拣货/manual-ship/waybill/ticket），以及 `orders.ts`、`orders.$id.ts`，鉴权走 `src/server/handheld-auth.server.ts`（authenticateDevice + resolveSessionUser + 按库位过滤）。

## 2. 最小新增数据模型（建议，待批准后再写迁移）

新表 `commerce_groupbuy_campaigns`：
- id, listing_id → commerce_listings, location_id（固定为总部库存点，加 CHECK 或触发器校验 kind=warehouse 且 shop_id IS NULL）
- category_code（与品类相关）, title, groupbuy_price numeric, compare_at_price
- starts_at, ends_at（CHECK ends_at > starts_at）
- quota_total int、quota_reserved int、quota_sold int（CHECK reserved+sold ≤ total）
- per_customer_limit int（待定）, status（draft/scheduled/active/ended/cancelled）, version, created_by, timestamps

新表 `commerce_groupbuy_reservations`（或复用 inventory_reservations，在 metadata 里加 campaign_id）：order_id 唯一, campaign_id, qty, state（reserved/consumed/released）。

防超卖：在一个 SECURITY DEFINER 事务里，先锁活动行（campaign FOR UPDATE），再锁总部 inv_stocks 行（FOR UPDATE），然后校验现在时间在 [starts_at, ends_at) 之间、剩余配额 ≥ qty、实物库存扣掉已预留之后 ≥ qty，再同时加配额预留和库存预留。配额与实物取较小值，任意一个不够就拒绝。锁顺序固定为 campaign → stock → order，避免死锁。

剩余可售 = min(quota_total − reserved − sold, 实物可用)，由服务端计算；倒计时用服务端返回的 now 和 ends_at。

## 3. 订单标记与独立结算

- commerce_orders 新增 `business_type text not null default 'ordinary'`，CHECK 取 ordinary/groupbuy，与 source_channel、sales_origin 分开。现有行不受影响。
- 团购从活动详情页直接独立结算，新 RPC `commerce_create_groupbuy_order`：一单只能有一个 campaign、一行商品；不接收普通购物车 items；**不修改普通购物车**。如果服务端在普通结算里收到团购 listing，按原价规则处理还是拒绝？建议拒绝（待确认）。
- 快照：order_items.settlement_snapshot 或 discount_snapshot 写入 {campaign_id, version, groupbuy_price, compare_at_price, starts_at, ends_at}；unit_price=团购价，original_unit_price=原价。
- 超时：沿用 reservation_expires_at（15 分钟）；在 commerce_release_expired_reservations 里补上"释放团购配额"（和库存释放同一事务，按 order_id 幂等，state 从 reserved 变 released 只发生一次）。
- 付款：沿用 prepare/apply_ordinary_payment；在付款事务里把 reserved 转为 sold（按 order_id 幂等）。活动过期后到账的情况沿用现有"预留过期"拒绝逻辑，走原有自动退款路径。
- 退款：沿用 prepare/apply_ordinary_refund。退款后是否回补配额，待确认（建议活动仍在进行中才回补，否则不回补）。

## 4. 权限、发货与 Android 契约

- 只允许总部人员处理：super_admin、hq_operator、warehouse_staff，并且对总部库位有 user_location_perms。门店角色没有总部库位权限，看不到也发不了；**不放开门店权限**。
- 发货只调用现有 `commerce_manual_ship_fulfillment`（p_location_id=总部仓库），不新建发货逻辑。
- ERP：`/orders/groupbuy` 独立页面，复用 listCommerceOrders 并加 business_type='groupbuy' 过滤，复用运单填写。
- Android：现有 `GET /api/public/handheld/fulfillments` 新增可选查询参数 `business_type=groupbuy`；返回项增加字段：business_type、campaign {id, title, groupbuy_price, ends_at}、order_no、recipient_name/phone（沿用现有脱敏规则）、shipping_address、status、tracking_no。所有字段都是新增，旧客户端可以忽略。设备必须绑定总部库位才能看到。

## 5. 未决业务项（必须确认后才能写实施计划）

1. 总部仓库目前没有可售库存，也没有授权人员，也没有手持设备绑定在总部库位（devices 表没有 location_id 列，绑定方式需要再查）。团购商品是先调拨到总部仓库，还是由运营直接入库？
2. 由谁操作：是否新增 hq_operator/warehouse_staff 账号并授权总部库位？目前只有 4 个 super_admin。
3. 每人限购数量；一单能不能买多件（宝藏团多为孤品，限量是指同款多件还是多条 listing）？
4. 运费：包邮、固定运费，还是沿用 commerce_quote_store_shipping？总部没有 shop_id，现有门店运费模板可能不适用。
5. 能否叠加优惠券、积分、会员价、翻筐乐？建议全部不能叠加。
6. 支付商户号：总部仓库没有绑定有赞门店或门店支付配置（store_payment_profiles 需要确认总部有没有），付款时用哪个收款主体？
7. 退款后是否回补配额；活动结束后未付款订单如何处理。
8. 是否同步有赞（建议不同步，只在小程序售卖）。
9. 团购 listing 能不能同时出现在普通列表里（建议在普通列表隐藏或只展示、不可加购）。

## 技术说明
- 清仓需求保持独立，本轮不涉及。
- 不部署腾讯；腾讯 live 基线可能和 Lovable main 不一致，实施前需要 Codex 在腾讯只读复核同样的计数。
- 本轮没有执行任何迁移或写操作。
