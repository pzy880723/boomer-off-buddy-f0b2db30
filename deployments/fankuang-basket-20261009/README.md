# 翻筐乐分筐 + 赠礼盲盒（候选，未应用、未发布）

## 迁移
- `0046_fankuang_basket_gifts.sql`：**未应用**到任何数据库；刻意不放入 `drizzle/migrations/`，避免被误跑。
- 不改写现网 `commerce_create_ordinary_order` / `commerce_create_ordinary_pickup_order`：包装函数
  `commerce_create_order_with_fankuang_gifts` 在同一事务内按现网 pg_proc 签名动态调用（白名单两函数），因此不会用旧 0040 覆盖腾讯现网定义。
- 上线前需要：创建标准 SKU「翻筐乐赠礼盲盒」（is_custom_price=false，不建库存、不建 listing），并写
  `app_settings(key='fankuang_gift_sku_id', value={"sku_id":"<uuid>"})`。
- 腾讯 timer：上海 00:00 调 `commerce_fankuang_rebuild_round()`；建议每 5 分钟调 `commerce_fankuang_refill()`（开始会话时也会补位）。

## 规则
- 每筐 100（CHECK 固定），资格同 `isInFankuang` 且已发布、SKU active、门店真实库存>0。
- 当日分筐幂等；售出/下架缺口由最新上架补齐，多余新品追加到未满或新筐。
- 会话快照冻结：进行中的筐直接返回，不追加、不随午夜重建；全部翻过或已不可售后才开新筐。
- 有效翻动 = 快照内、当前可售、本会话及本日首次；每次独立 1% 抽取（服务端 `random()`），client_op 重放返回原结果，回翻/刷新不重抽。
- 资格 available→reserved（下单）→consumed（付款）；未付款取消/关闭一次性释放（release_count），不午夜清空。
- 领取数 ≤ 可用资格 且 ≤ 订单付费件数（同 SKU 多件累计，赠礼 SKU 不计）；赠礼 SKU 禁止作为订单行（触发器）。
- 门店分配：在订单涉及门店中随机，结果写 `commerce_order_gift_allocations` 随订单固定；同键重试不重复，改变赠礼则 409。

## API（均需消费者 Bearer，响应 `Cache-Control: private, no-store`）
| 方法 路径 | 请求 | 响应 data |
|---|---|---|
| GET `/api/public/storefront/fankuang/session` | – | `null` 或 `{id,business_date,basket_no,status,listing_ids[],flipped_listing_ids[],unavailable_listing_ids[],created_at,completed_at}` |
| POST `/api/public/storefront/fankuang/session` | `{client_op_id}`(8–80) | 同上 + `replayed`,`resumed` |
| GET `/api/public/storefront/fankuang/basket` | – | `{session, items:[{listing_id,available,flipped,product}]}`（product 为商城商品 DTO） |
| POST `/api/public/storefront/fankuang/flip` | `{session_id,listing_id,client_op_id}` | `{flip_id,counted,won,entitlement_id,replayed,duplicate,reason?,session_completed}`，reason ∈ already_flipped/listing_unavailable/session_completed |
| GET `/api/public/storefront/fankuang/gift-balance` | – | `{available,reserved,consumed,available_entitlements:[{id,won_at}]}` |
| POST `/api/public/storefront/orders` | 原字段 + 可选 `gift_entitlement_ids: uuid[]`、`gift_count: int` | 原订单 + `gift_allocations:[{location_id,quantity}]`,`gift_replayed` |

错误码：`gift_exceeds_paid_items` 422（提示减赠礼或加购）、`gift_entitlement_unavailable` 409、`gift_sku_not_purchasable` 422、
`gift_idempotency_conflict` 409、`gift_not_configured` 503、`gift_checkout_not_enabled` 503、`gift_invalid` 400、
`client_op_conflict` 409、`listing_not_in_session` 422、`session_not_found` 404、`basket_empty` 404。

## ERP
订单门店子单页每店显示「翻筐乐赠礼盲盒 ×N」（读取 `commerce_order_gift_allocations`，员工按门店权限读）。

## 未验证
- 真实微信付款回调是否经 `payment_status='paid'` 更新触发 consumed；支付关闭 `commerce_close_ordinary_payment`、超时释放 `commerce_release_expired_reservations` 是否把订单置 cancelled/closed（释放依赖此）。
- 付款后退款/售后不退还资格（当前保持 consumed），需业务确认。
- 腾讯 shipping-quote overlay 未加赠礼字段（赠礼不影响运费）。
- 小程序/原生 UI、腾讯 timer、真实数据库应用均未做。
