# BOOMER ERP 自营网店与 POS 统一交易平台设计

## 目标

让 ERP 成为商品、库存、订单、支付、履约和退款的唯一主账。有赞继续作为可插拔销售渠道，
但不再决定内部数据模型。自营网店与门店 POS 共用同一套库存和订单状态机。

## 核心边界

- `inv_skus`、`inv_stocks`、`inv_stock_movements`：商品与库存唯一真源。
- `commerce_listings`：自营网店的销售展示配置，不复制库存。
- `commerce_orders`：统一销售订单，覆盖 `storefront`、`pos`、`youzan`、`manual`。
- `commerce_order_items`：订单行快照，支持数量。
- `inventory_reservations` + `inventory_reservation_lines`：待支付库存锁定。
- `commerce_payments`、`commerce_payment_events`、`commerce_refunds`：资金事实。
- `pos_registers`、`pos_shifts`、`pos_cash_movements`、`pos_receipts`：门店收银域。
- `sku_channel_listings`、`channel_sync_outbox`：有赞等外部渠道适配层。

## 商品语义

| 类型 | ERP 判定 | 下单数量 | 可售库存 |
| --- | --- | --- | --- |
| 自定义孤品 | `kind=single && is_custom_price=true` | 恒为 1 | 所属库位实存减有效锁定 |
| 标准商品 | `kind=single && is_custom_price=false` | 1..N | 所属库位实存减有效锁定 |
| 组包商品 | `kind=bundle` | 1..N | 各组成 SKU 可售量 / 组成数量的最小值 |

组包下单时锁定和扣减组成 SKU，不对组包父 SKU 维护一份独立可售库存。

## 统一订单

`commerce_orders.source_channel`：

- `storefront`：自营 APP / 小程序网店
- `pos`：门店收银
- `youzan`：有赞订单镜像
- `manual`：ERP 人工补录

`fulfillment_method`：

- `shipping`：快递发货
- `pickup`：门店自提
- `carryout`：门店现取，POS 默认

网店订单先锁库，支付回调成功后扣库。POS 订单在同一数据库事务内完成建单、收款记账和扣库。

## 支付原则

- 客户端永远不能直接把订单改为已支付。
- 每笔支付都有业务幂等键和渠道流水号。
- 微信/支付宝回调先验签、落原始事件，再推进支付状态。
- 未配置真实商户密钥时返回 `payment_not_configured`，不伪造支付成功。
- 现金支付仅允许 POS 已开班次使用，并产生现金抽屉流水。

## POS 最小闭环

1. 收银员登录 ERP，选择被授权门店。
2. 打开收银班次，记录备用金。
3. 扫条码、SKU 码或 EPC 加入购物车；重复扫描标准商品增加数量，孤品拒绝重复。
4. 可修改数量、整单优惠和备注，服务端重新核价。
5. 选择现金、微信、支付宝、银行卡或组合支付。
6. 服务端原子完成订单、支付、库存移动、小票号。
7. 可重打小票；退货必须引用原订单并生成退款与回补记录。
8. 交班时核对现金应有、实有和差异。

## 脱离有赞路径

1. ERP 先成为库存和订单主账，有赞只通过 outbox 同步。
2. 自营网店使用 storefront API 完成浏览、下单、支付、履约。
3. POS 覆盖门店线下销售、退货、交班和小票。
4. 有赞订单继续镜像到统一订单，核对稳定后逐店关闭有赞收银。
5. 最终停用有赞 adapter，不改商品、库存、订单或财务表。

## 安全与一致性

- 所有交易写操作走后端和 `service_role`，密钥不进入客户端。
- 所有 `SECURITY DEFINER` RPC 默认撤销 `PUBLIC` 执行权，只授权 `service_role`。
- API 先校验用户角色与库位权限，再调用 RPC。
- 所有客户端写请求必须带幂等键。
- 库存行按稳定顺序 `FOR UPDATE`，避免并发超卖和死锁。
- 新表全部启用 RLS；普通客户端不直接写交易表。

## UI 约束

POS UI 在代码实现前单独出设计稿。现有 ERP 页面结构不擅自改动；新增入口为一级「收银」，
核心屏幕为开班、扫码收银、付款、交易成功、订单查询、退货、交班七个页面。
