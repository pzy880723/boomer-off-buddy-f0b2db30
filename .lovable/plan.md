# 四店 POS 总部积分抵扣 / 取消补回 / 退款返分 — 只读审计与最小落地方案

本轮只读：没改代码、数据库和开关，没有操作资产，没有测试点数。

## 一、核对到的现状（本轮只读读取）

- 本地最新代码版本：`fb2deedbb29af4f9507fbbfbf3fd99cb97e3e192`（和你说的 canonical fb2deedb 一致）。
- 会员与余额概要：commerce_customers 共 11 名（active 10）；youzan_points_projection 有 10 条，其中 2 条余额大于 0，合计 129 分；本地 pos_customer_wallets 有 1 条非零（points 或 points_debt）。这里不列任何 ID 或联系方式。
- youzan_points_operations 有 3 条，全部 succeeded（来自旧测试会员 allowlist）。"安全测试账号"只能由 `YOUZAN_POINTS_WRITE_CUSTOMER_IDS` 来认定，本轮没有读取它的值。
- pos_payment_attempts 有 0 条。

### 数据库入口（实际已部署的定义和权限）
| 函数 | SECURITY DEFINER | 谁可执行 | 积分处理 |
|---|---|---|---|
| pos_complete_sale_v2(…10参) | 是 | postgres, service_role | 不处理积分 |
| pos_complete_sale_v3(…+p_points_to_redeem) | 是 | postgres, service_role | **读写本地 pos_customer_wallets**（旁路） |
| pos_complete_sale / _without_points | 是 | 仅 postgres | 旧入口 |
| pos_complete_return(…7参) | 是 | postgres, service_role | **按本地钱包返还，不碰 youzan_points_*** |
| pos_recover_sale_cancel(shift,operator,client_op_id) | 是 | postgres, service_role | 不碰 youzan_points_operations |
| pos_points_rules(customer) | 是 | postgres, service_role | 本地规则 |
| youzan_points_operation_begin / claim / finish | 是 | postgres, service_role | 总部扣退日志 |
| youzan_points_projection_* | 是 | postgres, service_role | 只读镜像 |

### youzan_points_operations 约束（已核对）
- UNIQUE(kdt_id, operation_key)；kind 只能是 debit/refund；refund 必须有 parent_id，debit 不能有。
- status 只能是 pending/processing/unknown/succeeded/blocked；points 范围 1..1e8；source_kdt_id、kdt_id 都必须大于 0。
- **缺口**：数据库没有限制"同一 parent 下累计 refund 不超过 debit.points"，也没有关联 POS 订单。

### 应用侧
- `src/routes/api/public/pos/sales.ts`：points_to_redeem>0 时先走 `assertNoPosPointsSpend`，返回 409 `pos_points_read_only`；之后的代码仍会调用 v3，等于留着本地钱包路径。
- `src/server/youzan-points-operation-production.server.ts`：扣退驱动。双开关加 allowlist，要求固定出口代理和总部 token；映射从**只读 node:sqlite**（`member_channel_links`）读取，检查唯一性和防冲突；按 begin→claim→execute→finish 执行，重复的 succeeded 直接返回。
  - **关键缺口**：它依赖 `node:sqlite`，只能在腾讯 Node 环境运行，**主 ERP（Worker 运行时）跑不了**。所以真实扣退只能放在 sidecar 执行，POS 请求本身不能同步调用它。
- `src/lib/pos/hq-read-only.ts`、`points-policy.server.ts`：只读取总部积分（canonical 里已有，主 APP 尚未部署）。

## 二、真实缺口
1. 结算前没有"冻结积分意图"，POS 订单也没有和 HQ debit 操作关联。
2. v3 和退货都在读写本地钱包，违反"总部唯一账本"。
3. 结果未知（unknown）时没有对账规则，可能被盲目重扣。
4. 退款累计返分没有数据库硬上限；现金退款和积分返还没有分开记账。
5. 取消（recover_sale_cancel）后不会补回已扣的分。
6. 主 APP 不能直接执行扣分，必须交给 sidecar worker 异步执行，执行前再确认一次。

## 三、最小集成设计

```text
POS 预结算 ──> pos_points_intent_create (DB, 冻结意图 + 订单草稿 status=points_pending)
                    │  校验：店员 store scope、location→source_kdt、HQ=parent、会员映射存在、余额镜像≥points、规则指纹
                    ▼
sidecar worker ──> youzan_points_operation_begin(debit, key=pos:{order}:debit) → 远端扣分
                    │  succeeded → pos_points_intent_confirm → 订单可结算（现金部分 = 应付 - 积分抵扣额）
                    │  blocked   → intent=released，订单不结算，提示换支付
                    │  unknown   → 仅用总部变更日志/余额对账（按 operation_key / 时间窗）判定，禁止重扣
                    ▼
POS 结算 ──> pos_complete_sale_v4：仅接受 intent=confirmed 且金额/会员/门店/指纹一致；不读写 pos_customer_wallets
取消 ──> 若 debit succeeded：建 refund(parent=debit, key=pos:{order}:cancel, points=全部)
退款 ──> 按退货行分摊 points_allocated 计算返分；DB 锁 debit 行，
         SUM(refund succeeded+pending+unknown) + 本次 ≤ debit.points，否则拒绝
```

### 新增数据库对象（一条 migration，只增不删，全部 service_role-only）
- 表 `pos_points_intents`：order_id, client_op_id, location_id, source_kdt_id, hq_kdt_id, customer_id, points, deduct_fen, rule_fingerprint, status(pending/dispatched/confirmed/released/unknown/cancelled), debit_operation_id, row_version；unique(location_id, client_op_id)。
- 表 `pos_points_refund_allocations`：intent_id, return_id 或 cancel 标记, points, refund_operation_id；unique(intent_id, return_id)。
- RPC：`pos_points_intent_create`、`pos_points_intent_confirm`（带 fencing token）、`pos_points_intent_release`、`pos_points_refund_reserve`（锁定后做累计上限检查）。
- `pos_complete_sale_v4`：内部复用 v2 的事务，加上 intent 校验，并把积分摊到订单行（写入已有 discount_snapshot 字段 points_allocated_fen/points）。
- `pos_complete_return_v2`：现金退款照旧；积分部分只登记 reserve，不返还到本地钱包。
- v3 和旧 pos_complete_return 不删除，但应用侧不再调用它们（停用不删），后续加注释 DEPRECATED。

### 应用和 sidecar 改动
- `sales.ts`：points>0 时走 intent 流程，返回 202 `points_pending`；之后轮询 intent 状态，confirmed 才调用 v4。409 只读 guard 保留，用新开关 `POS_HQ_POINTS_REDEMPTION_ENABLED` 加门店 allowlist 控制放行。
- 退货和取消路由：改调 return_v2 / cancel+reserve。
- sidecar：新增 points dispatcher，复用 `runProductionPointsOperation`，只处理 dispatched intent 和已登记的 refund；unknown 交给对账器，不重试远端写；`unknown` 对账依据只认总部官方变更日志里的 operation_key（备注字段），需先确认官方接口能写入/回读该备注。

### 状态分离（不混用）
- `nativeYoutzanPosInherited`：保持 false，不改。
- `erpPosHqRedemption`：新状态，依次为 disabled → canary_store → verified_store(kdt)，按店单独记录。
- posSafe 和 assetsEndToEnd 不硬改；只有在某店完成真实"扣→结算→退款返分→对账一致"之后，才单独为该店标记。

## 四、实施前需要你确认 / 外部前置
1. 有赞积分扣减/增加接口的官方正文：能不能带业务流水号或备注、重复调用的语义、能不能按流水回查。这决定 unknown 怎么对账；查不到就一律人工处理，绝不自动重扣。
2. 抵扣规则（1 元 = 多少分、单笔上限）以总部 getter 为唯一来源。
3. 测试会员：沿用旧 allowlist 会员，还是另外指定一名。
4. canary 顺序：建议美罗城单店 → 其他 3 店。

## 五、测试（实施时）
- SQL 隔离测试：意图唯一、跨店拒绝、未 confirmed 不能结算、累计返分上限、unknown 不重扣、取消全额返还只做一次。
- 路由合同测试：只读 guard 默认仍是 409；本地钱包不会被读写。
- 抠图和修图相关的代码、模型、依赖、提示词、调用路径全部不动。
