# 翻筐乐分筐 + 赠礼盲盒（候选，未应用、未发布）

## 迁移
- `0046_fankuang_basket_gifts.sql`：**未应用**到任何数据库；刻意不放入 `drizzle/migrations/`，避免被误跑。
- 不改写现网 `commerce_create_ordinary_order` / `commerce_create_ordinary_pickup_order`：包装函数
  `commerce_create_order_with_fankuang_gifts` 在同一事务内按现网 pg_proc 签名动态调用（白名单两函数），因此不会用旧 0040 覆盖腾讯现网定义。
- 动态调用只绑定调用方真实提供的键（JSON null 视为调用方明确传 NULL）；未提供的参数省略让原函数 DEFAULT 生效，无 DEFAULT 则报 `missing create argument`；重载/OUT/VARIADIC 签名一律拒绝。
- 上线前需要：创建标准 SKU「翻筐乐赠礼盲盒」（status=active、is_custom_price=false、**inventory_policy='unlimited'**，不建库存、不建 listing；tracked/inactive 会被 `gift sku invalid` 拒绝；SKU 尚未创建，未配置时下单赠礼返回 `gift_not_configured`），并写
  `app_settings(key='fankuang_gift_sku_id', value={"sku_id":"<uuid>"})`。
- 腾讯 timer：上海 00:00 调 `commerce_fankuang_rebuild_round()`；建议每 5 分钟调 `commerce_fankuang_refill()`（开始会话时也会补位）。

## 规则
- 每筐 100（CHECK 固定），资格同 `isInFankuang` 且已发布、SKU active、门店真实库存>0。
- 当日分筐幂等；售出/下架缺口由最新上架补齐，多余新品追加到未满或新筐。
- 会话快照冻结：进行中的筐直接返回，不追加、不随午夜重建；翻动营业日 = 快照所属营业日。
- "已看过"统一口径 `commerce_fankuang_seen(customer, 快照营业日, listing)`，session_json / complete_if_done / start_session / flip 共用。新会话只取仍有未看过可售商品的筐、快照只含未看过商品；全部看完明确 `basket_empty`；补位新品未看过仍可翻。
- 有效翻动 = 快照内、当前可售、本营业日首次；每次独立 1% 抽取（服务端 `random()`），client_op 重放返回原结果，回翻/刷新不重抽。
- 资格 available→reserved（下单）→consumed（付款）；未付款取消/关闭一次性释放（release_count），不午夜清空。
- 领取数 ≤ 可用资格 且 ≤ 订单付费件数 = `commerce_order_items.unit_price > 0` 的非赠礼行 `quantity` 之和（同 SKU 多件累计，含特价/清仓，零元行不计）；`commerce_orders.total_amount <= 0` 拒绝领赠礼；赠礼 SKU 禁止作为订单行（触发器）。
- 门店分配：在订单涉及的付费行门店中随机，结果写 `commerce_order_gift_allocations` 随订单固定。
- 幂等：下单前在顾客锁内查该幂等键订单是否已存在，与持久快照 `commerce_order_gift_claims(order_id, requested_ids, requested_count, claimed_ids, status)` 比对；取消后快照标 released、资格回到 available，同键重试原样返回（`gift_claim_status='released'`）不二次领取，改变赠礼仍 409。

## API（均需消费者 Bearer，响应 `Cache-Control: private, no-store`）
| 方法 路径 | 请求 | 响应 data |
|---|---|---|
| GET `/api/public/storefront/fankuang/session` | – | `null` 或 `{id,business_date,basket_no,status,listing_ids[],flipped_listing_ids[],unavailable_listing_ids[],remaining_count,created_at,completed_at}` |
| POST `/api/public/storefront/fankuang/session` | `{client_op_id}`(8–80) | 同上 + `replayed`,`resumed` |
| GET `/api/public/storefront/fankuang/basket` | – | `{session, items:[{listing_id,available,flipped,product}]}`（product 为商城商品 DTO） |
| POST `/api/public/storefront/fankuang/flip` | `{session_id,listing_id,client_op_id}` | `{flip_id,counted,won,entitlement_id,replayed,duplicate,reason?,session_completed}`，reason ∈ already_flipped/listing_unavailable/session_completed |
| GET `/api/public/storefront/fankuang/gift-balance` | – | `{available,reserved,consumed,available_entitlements:[{id,won_at}]}` |
| POST `/api/public/storefront/orders` | 原字段 + 可选 `gift_entitlement_ids: uuid[]`、`gift_count: int` | 原订单 + `gift_allocations:[{location_id,quantity}]`,`gift_claim_status`(reserved/consumed/released/null),`gift_replayed` |

错误码：`gift_exceeds_paid_items` 422（提示减赠礼或加购）、`gift_entitlement_unavailable` 409、`gift_sku_not_purchasable` 422、
`gift_idempotency_conflict` 409、`gift_not_configured` 503、`gift_sku_invalid` 503、`gift_requires_paid_items` 422、`gift_checkout_misconfigured` 500、`gift_checkout_not_enabled` 503、`gift_invalid` 400、
`client_op_conflict` 409、`listing_not_in_session` 422、`session_not_found` 404、`basket_empty` 404。

## ERP
订单门店子单页每店显示「翻筐乐赠礼盲盒 ×N」（读取 `commerce_order_gift_allocations`，员工按门店权限读）。

## 测试
`bash tests/sql/fankuang_basket/run.sh`（本地临时集群，每个用例文件独立新库）：`cases.sql` 7 组 + `cases_review_20261008.sql` 7 组；`bun test src/lib/commerce/fankuang-gift.test.ts src/lib/commerce/fankuang.test.ts` 17 项。

## 未验证
- 真实微信付款回调是否经 `payment_status='paid'` 更新触发 consumed；支付关闭 `commerce_close_ordinary_payment`、超时释放 `commerce_release_expired_reservations` 是否把订单置 cancelled/closed（释放依赖此）。
- 付款后退款/售后不退还资格（当前保持 consumed），需业务确认。
- 腾讯 shipping-quote overlay 未加赠礼字段（赠礼不影响运费）。
- 小程序/原生 UI、腾讯 timer、真实数据库应用均未做。
