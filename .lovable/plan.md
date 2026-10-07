# 小程序门店自提与同城配送：只读核查结果与最小兼容合同（未开发）

当前提交：`88b178a3`。数据库为 Lovable 内嵌库（已只读查询）。腾讯生产部署状态未核实，不假设已部署。

## 1. 现状（只读核查已确认）

**下单 / 报价 / 付款**
- 下单入口：`src/routes/api/public/storefront/orders.ts`。普通微信模式调用 RPC `commerce_create_ordinary_order`，否则调用 `commerce_create_order_v2`。
- 下单参数里只有快递相关字段（`p_courier_provider`、`p_courier_service_code`、`p_shipping_fee`、`p_quote_snapshot`、收件地址），**没有配送方式参数**。数据库报错 `ordinary express delivery only` 时，接口返回"目前仅支持普通快递配送"。
- 快递服务校验：`src/lib/commerce/order-policy.ts` 的 `normalizeCourierChoice`，只接受 `SF_*`、`CAINIAO_*`、`PLATFORM_RECOMMENDED`。
- 报价 RPC：`commerce_quote_checkout(p_customer_id, p_items, p_coupon_id)`、`commerce_quote_store_shipping(p_items)`。src 内没有任何代码调用 `commerce_quote_store_shipping`，也没有独立的运费报价接口。
- 付款成功：RPC `commerce_mark_ordinary_order_paid` / `commerce_mark_order_paid`。按迁移文件，付款时会为每个商品行所在门店插入一条 `fulfillments`（order_id, location_id）。

**表约束（数据库读回）**
- `commerce_orders.fulfillment_method`：只能是 `shipping | pickup | carryout`（`pickup` 值已存在，但商城下单没有路径能写入它）。
- `commerce_orders.courier_provider`：只能是 `sf | cainiao | platform`。
- `commerce_orders.order_status`：`pending_payment | confirmed | processing | completed | cancelled | after_sale | closed`。
- `fulfillments.status`：`unallocated | allocated | picking | picked | packing | packed | handover_ready | handed_over | exception`。
- `shipments.provider`：只能是 `sf | cainiao`；`shipments.status`：`not_created | quoting | booked | label_created | picked_up | in_transit | delivered | cancelled | failed`。`shipments` 表已有 `pickup_window`、`provider_order_no`、`tracking_no`、`idempotency_key` 字段。
- 现有商城订单只有 3 张，全部是 `shipping` + `PLATFORM_RECOMMENDED`。

**门店履约（员工端）**
- 手持端接口：`src/routes/api/public/handheld/fulfillments*.ts`，包括列表、查询、领取、绑定周转箱、拣货扫码、拣货完成、缺货、小票、面单。门店授权统一走 `src/server/handheld-fulfillment-access.server.ts` 的 `authorizeFulfillment`（设备令牌 + 员工会话 + 库位）。
- 数据库 RPC：`fulfillment_claim_task`、`fulfillment_bind_tote`、`fulfillment_pick_scan`（两个重载）、`fulfillment_complete_pick`。
- 面单接口 `fulfillments.$id.waybill.ts` 明确写着：没有接入任何快递商户，只返回"未配置"状态，不伪造运单号。

## 2. 明确缺口

1. **自提**：没有提货码字段、没有提货码生成、没有核销接口或 RPC，也没有"备货完成可提货 / 已提货"的状态。`fulfillments.status` 里没有"待提货"这一档，`handed_over` 可以借用为"已交付"。
2. **同城配送**：代码里没有任何顺丰同城或闪送的代码（搜索"同城/闪送/shansong/same_city"在业务代码中没有结果），没有报价，也没有发单。`courier_provider` 和 `shipments.provider` 的取值都不允许同城服务商。
3. **快递和同城必须分开**：现有 `SF_*` 前缀代表顺丰快递；同城需要独立的服务商取值，不能复用 `sf`。
4. **下单不支持选择配送方式**：下单接口和 RPC 都没有配送方式参数，数据库强制只能普通快递。
5. **报价没有对外接口**：运费报价只在 RPC 里，没有给小程序用的报价接口，也没有报价有效期或签名，防止付款前被篡改。
6. **叫单时机**：没有"备货完成后才叫同城骑手"的触发和发单任务表。
7. **订单详情**（`orders.$id.ts`）目前不返回提货码、自提门店、同城骑手状态（以子代理复核结果为准）。

## 3. 建议的最小兼容合同（供审查，未实现）

**下单**：`POST /storefront/orders` 新增可选参数 `delivery_method: "express" | "pickup" | "same_city"`，默认 `express`，旧客户端不受影响。
- `pickup`：需要 `pickup_location_id`（必须是营业门店，且订单所有商品都在这家店）；不需要收件地址，运费为 0。
- `same_city`：需要 `same_city_quote_id`（来自报价接口），以及用户选定的 `provider: "sf_same_city" | "shansong"`。

**报价**：新增 `POST /storefront/same-city/quotes`，参数为商品清单和收件地址，同时向两家服务商报价，返回 `{quotes:[{quote_id, provider, fee_fen, eta_minutes, expires_at}]}`。报价由服务端保存并设定有效期，下单时按 `quote_id` 重新核对金额。

**付款后**
- 自提：生成 6–8 位提货码。只存哈希，订单详情只对本人返回明文。履约单进入备货。
- 同城：进入备货，暂不叫单。

**门店端（手持）**
- `POST /handheld/fulfillments/$id/ready`：备货完成。同城订单此时排入发单任务；自提订单变为"待提货"。
- `POST /handheld/pickups/verify {location_id, code}`：核销提货码，走原子 RPC，检查门店和状态，防止重复核销，核销后变为已提货。

**数据库（新迁移，需单独授权）**
- `commerce_orders`：新增 `delivery_method`（可空、默认 express）、`pickup_location_id`、`pickup_code_hash`、`pickup_verified_at/by`。`fulfillment_method` 的约束保持不变，把 `pickup` 映射到现有值。
- `fulfillments.status`：新增 `ready_for_pickup`。
- 新表 `same_city_quotes`、`same_city_dispatches`（发单任务：租约、幂等键、失败可重试），或者扩展 `shipments.provider` 允许 `sf_same_city`、`shansong`。
- 新 RPC：`commerce_pickup_verify`、`fulfillment_mark_ready`。权限只给服务端（service_role）。

**服务商适配器**：顺丰同城和闪送各自独立实现，需要商户账号和密钥（由用户在 Secrets 里添加，并走固定出口 IP）。拿到真实账号前只返回"未配置"，不伪造报价或运单号。

## 4. 接入点

- 小程序：结算页调用报价接口；下单时传配送方式；订单详情读取提货码和配送状态。客户端由你本地实现。
- ERP：在手持端现有履约流程（领取 → 拣货 → 拣货完成）后加"备货完成"和"核销提货码"两个动作，复用 `authorizeFulfillment` 的门店授权。
- 后台：发单任务复用现有"租约 + 定时脚本"模式，在腾讯上运行。

## 5. 需要你先决定

- 同城配送的商户账号、对接方式，以及是否已有接口文档。
- 自提是否只允许单店订单（建议只允许）。
- 是否授权本合同进入实现（迁移、接口、测试）。
