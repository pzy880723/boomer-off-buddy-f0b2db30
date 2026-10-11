# 订单提醒 / 快递回传 / 门店自提 / 同城人工配送：只读审计与最小方案

本轮只读：无代码、数据库、界面改动，未发布；腾讯未部署。打印机共享已取消，不在本计划内。
当前提交：`e5277143026f7165e4d3bfc80b155229686c4df8`（Lovable 工作副本）。

## 一、审计结论（已有 / 未接通）

| 能力 | 状态 | 证据 |
|---|---|---|
| 已付款订单提醒到 ERP/手持机 | 未接通 | 付款回调 `src/routes/api/public/storefront/payments.callback.$provider.ts` 不写通知；`inv_handheld_notifications` 0 行；ERP 只有网页每15秒刷新（`src/routes/orders.online.tsx:79`） |
| 系统推送凭证 | 不存在 | 项目密钥中无 JPush/个推/TPNS/FCM 类项；仅有腾讯短信、有赞、AIGC 等 |
| 快递录单号回传顾客 | 未接通 | `fulfillments.$id.waybill.ts:14` 明确无承运商契约前不返回运单号，只报 `carrier_not_configured`；`shipments` 表有 `tracking_no` 字段但 0 行；没有员工手工录单号的接口 |
| 顾客看物流 | 读路径已有 | `storefront/orders.$id.ts:54` 返回 fulfillments→shipment→events，录入后即可显示 |
| 门店自提下单 | 已有，但受支付开关阻断 | `storefront/orders.ts:51,106-128`：pickup 需已验证手机号；仅 `ordinary_wechat` 支付模式开放，否则 503 `checkout_not_enabled` |
| 每门店独立二维码+4位码 | 已有 | 数据库触发器在付款事务内按门店子订单发码（`commerce_pickup_issue_codes` 等）；`commerce_pickup_codes` 当前 0 行 |
| 备货/核销/重复/错门店/售后 | 已有（库内） | `commerce_pickup_mark_ready`、`commerce_pickup_redeem`、`commerce_pickup_block_reason`、`commerce_pickup_actor_can` 存在；ERP 入口 `src/lib/pickup.functions.ts`；SQL 隔离测试 `tests/sql/pickup/*`（重复核销、并发、加固用例） |
| 手持机自提核销 | 未接通 | 手持 handheld 路由中无 pickup 接口（只有 fulfillments 拣货/工单/运单） |
| 小程序看不到自提入口 | 推断：开关未开 | Lovable 侧无普通微信支付配置，`ordinaryPaymentPolicy` 非 `ordinary_wechat` → 后端拒绝 pickup；腾讯实际环境变量需 Codex 核对；小程序前端是否按此隐藏入口不在本仓库 |
| 订单配送方式约束 | 无同城 | `commerce_orders.fulfillment_method` CHECK 仅 `shipping/pickup/carryout`；接口仅 `express/pickup` |
| 来源渠道 | 已有 | `source_channel` CHECK `storefront/pos/youzan/manual`；平台来源写 `metadata.sales_origin`（miniapp/app/web） |
| 运费报价 | 仅快递 | `commerce_quote_checkout(_v2)`、`commerce_quote_store_shipping` 存在；无同城报价 |
| 运费补款 | 不存在 | 无补运费/二次支付相关表、函数或接口 |
| 产品开关表 | 无 | `app_settings` 中无配送/自提/通知类键 |

现有订单数据（仅聚合）：shipping 3、carryout 1；自提码 0；运单 0。

## 二、最小修复方案（分阶段，均需你另行批准）

**阶段1 订单提醒（不需推送凭证）**
- 付款确认事务内写 `order_paid` 事件，按订单各门店子订单分发，唯一键（事件类型, 订单, 门店）防重复回调。
- 手持机经现有 `/api/public/handheld/notifications(/since)` 补偿拉取；员工领取履约或备货后标记已处理，同账号多机同步消除。
- 改动：1个增量迁移（触发器/函数）+ 通知读取不变 + 测试。

**阶段2 快递手工录单号**
- 新增手持/ERP 录单接口：员工+门店权限、履约已拣货、`client_op_id` 幂等；写 `shipments`（provider=manual、tracking_no）和 `shipment_events`。
- 顾客端沿用订单详情读路径，不伪造轨迹。

**阶段3 门店自提补全**
- 手持机新增核销/备货接口，直接调用既有 RPC（权限、锁在库内）。
- 由 Codex 核对腾讯普通微信支付开关；未开前小程序不显示自提。

**阶段4 同城人工配送（流程待你答复，未批准）**
- 建议流程：商品先付 → 店员电话确认 → ERP 报运费 → 顾客在原订单补付运费 → 付款后才可配送/录骑手单号；顾客不同意可申请取消/退款。
- 需要：配送方式新增同城值（增量放宽 CHECK）、运费补款子单与回调、补款前禁止配送状态推进。
- 建议跨门店同城暂不开放；多门店订单是否按店分别配送需你确认。
- 补款不得重新预留库存、重复发赠礼、重复计积分或核销券。

## 三、开放入口前的阻断项
1. 腾讯普通微信支付模式未核实开启 → 自提入口不可开放。
2. 同城补款流程未获批准、无补款支付实现 → 同城不可开放。
3. 无录单号接口 → 快递“已发货+单号”不可对顾客承诺。
4. 无推送凭证 → 锁屏/后台提醒不可承诺；阶段1只保证前台与补偿拉取。

## 四、可复现验证方法（不创建真实订单/支付/退款/发货/核销）
- 数据库函数与约束：只读查询 `pg_proc`、`pg_constraint`（同上表）。
- 自提逻辑：`bash tests/sql/pickup/run.sh`（本地临时库）。
- 下单校验：`src/lib/commerce/order-policy.test.ts`、`pickup-view.test.ts`。
- 新增阶段均配本地 SQL 隔离测试与单元测试，不连生产。

## 技术细节
- 每阶段一份可回滚增量迁移；RLS 仅服务端写；不改收银、积分、有赞、原图权限。
- 新架构规则写入 `src/server/AGENTS.md`。
- Lovable 发布不等于腾讯上线，腾讯由 Codex 部署。
