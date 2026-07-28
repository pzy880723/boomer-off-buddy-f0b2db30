# 商城市集与手持履约后端（第一阶段）

本阶段把 Vintage 小程序/App 的市集订单与 ERP 库存、手持设备拣货连接起来。ERP/Supabase 是商品、库存、订单和履约的唯一数据源，客户端只调用服务端 API。

## 已实现范围

- 一物一件商品发布表 `commerce_listings`
- 订单创建、15 分钟库存预留、支付后正式扣减库存
- 支付流水幂等与超时预留校验
- 按门店/仓库拆分履约任务
- 手持设备领取任务、绑定周转筐、扫码拣货、完成拣货
- 错货拦截、扫码操作幂等、履约扫描审计
- 包裹、打包证据、运单、物流事件、打印事件的数据结构
- 有赞门店商品查询与商品发布服务函数

数据库迁移：

```text
supabase/migrations/20260713090000_commerce_fulfillment_core.sql
```

## Storefront API

基础路径：`/api/public/storefront`

| 方法 | 路径            | 说明                                                       |
| ---- | --------------- | ---------------------------------------------------------- |
| GET  | `/products`     | 已发布商品列表，支持 `category`、`location_id`、`q`、分页  |
| GET  | `/products/:id` | 商品详情                                                   |
| GET  | `/orders`       | 当前用户订单列表，需要腾讯云消费者 Bearer JWT              |
| POST | `/orders`       | 创建订单并预留库存，需要 Bearer Token 和 `Idempotency-Key` |
| GET  | `/orders/:id`   | 当前用户订单详情、履约和物流信息                           |

消费者账号与 ERP 员工账号分离，完整约定见
[`consumer-auth-tencent.md`](./consumer-auth-tencent.md)。

创建订单的 `courier_service_code` 当前支持：

- `SF_*`
- `CAINIAO_*`
- `PLATFORM_RECOMMENDED`

## Handheld API

基础路径：`/api/public/handheld`

| 方法 | 路径                              | 说明                              |
| ---- | --------------------------------- | --------------------------------- |
| GET  | `/fulfillments`                   | 当前设备门店的履约任务            |
| GET  | `/fulfillments/:id`               | 订单、商品、库位/门店、周转筐详情 |
| POST | `/fulfillments/:id/claim`         | 领取拣货任务                      |
| POST | `/fulfillments/:id/bind-tote`     | 扫描并绑定周转筐                  |
| POST | `/fulfillments/:id/pick-scan`     | 扫商品 EPC/条码确认拣货           |
| POST | `/fulfillments/:id/pick-complete` | 全部商品确认后完成拣货            |

`pick-scan` 必须传 `client_op_id`，用于设备断网重试时防止重复操作。

## 有赞接口

服务端函数：

- `queryOfflineProducts`
- `releaseOfflineProduct`

对应官方接口：

- `youzan.retail.open.offline.spu.query` `3.0.0`
- `youzan.retail.open.offline.spu.release` `3.0.0`

查询结果只用于渠道商品映射，不使用官方已废弃的 `sell_stock_count` 作为 ERP 实时库存。ERP 库存仍以 `inv_stocks` 和库存流水为准。

## 部署顺序

1. 拉取最新代码。
2. 在目标 Supabase 项目执行迁移 `20260713090000_commerce_fulfillment_core.sql`。
3. 部署 TanStack/Cloudflare 应用。
4. 用服务端支付回调调用 `commerce_mark_order_paid`；客户端不得直接调用数据库 RPC。
5. 配置定时任务调用 `commerce_release_expired_reservations()`，建议每分钟执行一次。
6. 创建门店周转筐数据后，手持设备即可进入拣货流程。

## 下一阶段

以下数据结构已预留，但业务接口尚未在本阶段实现：

- 打包开始、打包扫码与封箱完成
- 打印拣货小票和快递面单
- 上传封箱前/封箱后照片
- 顺丰与菜鸟报价、下单、取消、轨迹回调
- 按有赞店铺“进出存/共享库存”配置接入 `youzan.retail.open.offline.spu.update` 或库存调整接口
- 快递上门取件与交接确认
- ERP Web 的订单、履约、异常、物流管理界面

Lovable 后续开发 ERP Web 页面时，应直接使用以上表和 API，不要另建一套订单或履约状态。
