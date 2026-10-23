# 四店 POS 总部积分抵扣 / 取消补回 / 退款返分：只读审计（校正版）与最小落地方案

本轮只读：代码、数据库、开关都没动，也没有操作资产。实际 SQL 用 pg_get_functiondef 读回，本地 canonical 为 `fb2deedbb29af4f9507fbbfbf3fd99cb97e3e192`。

## 一、前提校正（已采纳）
- 主 ERP 跑在腾讯 PM2 Node（boomer-off-buddy，run-tencent-erp.sh），支持 node:sqlite，所以生产 driver 可以在主进程里调用，只需固定 proxy 加 Node 运行时 gate。后台补偿队列仍单独运行，保证可靠。
- 现有账本已经具备退款上限和同一会员串行执行，不会重做。

## 二、实际 SQL 读回结论

### youzan_points_operation_begin（已有，复用）
- 参数校验；按"总部+会员"和"总部+yz 身份"两把 advisory 锁串行。
- (kdt, operation_key) 相同且 payload 也相同时按幂等返回，payload 不同时报 `operation_key_payload_conflict`。
- 校验会员为 active、kdt 必须是 active 的 hq，source 必须属于该总部（`source_shop_not_under_head`，防串店）。
- 会员与 yz 身份必须一一对应（`identity_customer_conflict`）。
- 同一会员只要还有 pending/processing/unknown/blocked 的操作，就拒绝新操作（`customer_operation_in_flight`）。
- refund 会锁住父行（FOR UPDATE），要求父行 succeeded 且身份和门店一致，并把所有状态的子退款累加后与 debit.points 比较，超出即拒绝（`refund_exceeds_debit`）。**退款上限已经在数据库层生效**。

### youzan_points_operation_claim（真实缺口）
- 只跳过 succeeded 和租约未到期的 processing 两种情况。**unknown、blocked、租约过期的 processing，只要 attempts<8 且创建不到 24h，就会被重新 claim 并再次发送远端写**。这与"结果未知不得盲重扣"直接冲突，必须修。

### youzan_points_operation_finish（复用）
- 只能写 succeeded/unknown/blocked，带 claim_token 和租约 fencing。

### driver（`src/server/youzan-points-operation.server.ts`）
- debit 调 decrease，refund 调 increase，`biz_value = boomer-points:{operation.id}`。这个格式正好能和官方 4.0.2 日志里的 data.items.biz_value 对账。

### POS 入口
| 入口 | 实际行为 |
|---|---|
| pos_complete_sale_v2 | 直接调 v3，p_points=0 |
| pos_complete_sale_v3 | points>0 时只允许现金 tender（否则 `points_async_not_supported`）；锁本地 pos_customer_wallets；用本地 pos_points_rules；扣本地钱包并写 commerce_points_ledger；按行写 discount_snapshot.points_allocated（行分摊，**可复用**） |
| pos_complete_return | 按 points_allocated×退货数量÷原数量 计算返分（**算法可复用**）；但返还进了本地钱包和 commerce_points_ledger |
| pos_recover_sale_cancel | 只按 client_op_id 取消或回放，不处理积分 |
| 扫码 pos-payment.server.ts | 创建时 points≠0 返回 422；支付成功后的 finalize 也拒绝 points；之后走 v2 |
| sales.ts | 已有 409 `pos_points_read_only` guard（canonical 有，主 APP 未部署） |

### 数据概要（只读）
会员 11 名，其中 active 10；总部镜像 10 条，2 条余额大于 0，合计 129 分；本地钱包有 1 条非零，本方案不读也不写它；operations 共 3 条，全部 succeeded。测试会员只认 allowlist，本轮没读取它的值。

## 三、真实缺口（只列这些）
1. claim 会重发 unknown、blocked 和过期的 processing（盲重扣风险）。
2. POS 订单和总部 debit 没有关联，也没有"先冻结意图、远端确认后才结算"的流程。
3. v3 和 return 用的是本地钱包与本地规则；cancel 不会补回积分。
4. 扫码支付完全不支持积分。
5. unknown 没有只读对账器。

## 四、最小设计

### 4.1 修 claim 与对账（一条 migration，只增不删）
- claim 改为只领取 `pending`。租约过期的 processing、以及 unknown，一律转入 `reconcile_pending`（新增状态值，CHECK 用 NOT VALID 方式追加），**不再发远端写**。blocked 不领取。
- 新增 `youzan_points_operation_reconcile(p_id, p_claim_token, p_result, p_evidence)`，service_role-only，带 fencing，按对账结果分三种处理：
  - matched：日志唯一命中 biz_value，HQ 与 owner 正确，sign 和 amount 精确一致（debit 为负数），且分页完整 → 记为 succeeded。
  - absent：分页完整、覆盖时间窗、确认没有命中 → 仍保持 unknown，交人工处理，**不自动重发**。是否允许"确认不存在后用同一 key 重发一次"，要等你确认官方 biz_value 的重复语义后再定。
  - 余额相等、读不到或分页不完整 → 保持 unknown，不判成功也不判失败。
- 对账器复用 youzanFetch、组织/总部选择和 member-keyset 风格的有界分页，只调用读接口。

### 4.2 冻结意图（新表 + RPC，service_role-only，GRANT 齐全）
- `pos_points_intents`：location_id, shift_id, client_op_id, customer_id, source_kdt_id, hq_kdt_id, points, deduct_fen, rule_fingerprint（取自总部 getter 指纹）, sale_request_hash, tender_mode(cash|async), status(frozen/debit_pending/confirmed/settled/released/unknown/cancel_refund_pending/cancelled), debit_operation_id, payment_attempt_id, row_version；unique(location_id, client_op_id)。
- `pos_points_intent_freeze`：校验店员 store scope 和班次，location 必须映射到 source_kdt 且属于总部，规则指纹要与当前一致，会员映射要存在，镜像余额要够；然后在同一事务里调用 begin(debit, key=`pos:{intent}:debit`)，与 operation 一一绑定。
- `pos_points_intent_mark`：只在 operation=succeeded 时才设为 confirmed；operation blocked 时设为 released；unknown 时同步为 unknown（POS 显示"待确认"，沿用现有的恢复交互）。

### 4.3 结算
- 新增 `pos_complete_sale_v4`：复用 v3 的金额、上限、授权和行分摊逻辑，但积分来源换成 intent。要求 intent=confirmed，且 hash、会员、门店、点数一致，**不读写 pos_customer_wallets，也不写 commerce_points_ledger**。成功后 intent 设为 settled 并关联 order。
- 现金：freeze → driver 扣分（主进程同步执行一次，失败或未知交给后台队列）→ confirmed → v4。
- 扫码：freeze → confirmed → 创建 payment_attempt（金额为扣除积分后的金额，attempt 绑定 intent）→ 支付成功事件 finalize 调 v4（替代 v2）。支付失败、关闭或超时时，intent 转为 cancel_refund_pending。
- 现金和积分分开：订单 tender 只记录实收金额；积分抵扣额单独记在 benefit_snapshot.points_redemption 并标明来源 hq_ledger。

### 4.4 取消补回 / 退款返分
- 取消（pos_recover_sale_cancel 新增一个包装 v2，或者扫码关闭时）：如果 debit 是 succeeded，调 begin(refund, parent, key=`pos:{intent}:cancel`, 全额)；如果 debit 是 unknown，先对账，不急着补。
- 退货：新增 `pos_complete_return_v2`。现金部分沿用原逻辑；积分按现有的行分摊算法计算本次应返分数，调 begin(refund, parent, key=`pos:{return}:refund`)。累计上限由 begin 负责。退货回放读取的是 operation，而不是本地 ledger。
- 旧 v3 和 pos_complete_return 不删除，应用侧也不再调用，加上 COMMENT DEPRECATED。

### 4.5 开关与状态
- 新增 `POS_HQ_POINTS_REDEMPTION_ENABLED` 和门店 allowlist；默认 409 guard 保持不变。
- 每店单独记录 `erpPosHqRedemption`：disabled / canary / verified_cash / verified_async。这个状态与 `nativeYouzanPosInherited`（保持 false）分开记录；posSafe 和 assetsEndToEnd 都不硬改。
- 只有一家店完成"现金 + 扫码"两条链路，各自都真实走完"扣分→结算→取消补回/退款返分→日志对账一致"，才能把该店标为 verified。四店不能只靠现金链路宣称已全部通过。

## 五、测试（实施时）
- 隔离 SQL：claim 不领取 unknown、blocked 和过期 processing；reconcile 的三种结果；freeze 跨店会被拒绝；未 confirmed 的 intent 不能结算；v4 不碰钱包；扫码 finalize 必须绑定 intent；取消和退款的累计上限；幂等回放。
- 对账单元测试：唯一命中、多条命中、owner 错误、amount 符号错误、分页不完整、余额相等。
- 路由：默认 409，allowlist 外的门店仍为 409。

## 六、实施前依赖
1. 你确认实施范围后再动手。真实测试（原测试会员、最多 1 分、四店标注测试单、不实收款、余额恢复）要等你拿到授权回复后才进行。
2. 官方 biz_value 的重复提交语义（absent 后能否用同一 key 重发）。没有确认之前一律人工处理。
3. 抠图和修图相关的代码、模型、依赖、提示词、调用路径全部不动。
