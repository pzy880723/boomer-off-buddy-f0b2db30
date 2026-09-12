# 设计评审（暂定）：收款事实与履约阻断解耦

状态：**仅设计评审，未实现、未验收、未修复**。本轮只写本文件，未改应用代码/迁移/数据库/配置/cron/roadmap，未部署，未执行支付或库存写操作。
用户已允许按暂定逻辑继续设计；订单完整流转细节、主状态枚举、退款/客服/人工操作流程仍**待后续确定**，本轮不定死。
诊断 commit：`ec1de47acafbf6a46e421de464a51f40c8adef5f`（应用代码）。
未读取也未返回任何用户/订单支付明细或凭证。

## 0. 只读核实的函数指纹（本轮实查）

| 函数 | `md5(pg_get_functiondef)` |
|---|---|
| `commerce_create_order_v2` | `148a572ee50df61dfa68e8cafa65aad8` |
| `commerce_mark_order_paid`（legacy） | `11962a3b03ba8ad843212410d7489bf8` |
| `commerce_mark_ordinary_order_paid` | `e3a2fd09714c60f149fcee8a6e74b42d` |
| `commit_sale` | `6da8bf20487899ac1a0d6c1c2614f21b` |
| `fulfillment_claim_task` | `1243d2d28d016c41ea1bdc8c79a4ec7b` |

注：前四项与你提供的值一致，仅 `commit_sale` 你写的是 `6da3bf20…`，本轮实测为 `6da8bf20…`（第 4 位 `3` vs `8`）。
按本轮实测为准，差异原因未知（可能为转录），**不作为版本漂移结论**。

## 1. 现有入口：哪些仅凭 paid/confirmed 就继续自动流转

### 已证实（源码/函数体只读）

- **付款即建履约（关键点）**：`commerce_mark_ordinary_order_paid` 函数体内，
  按行 `PERFORM public.inv_apply_movement(..., 'commerce_sale', ...)` 扣库存（第 31 行附近），
  紧接 `INSERT INTO public.fulfillments(order_id, location_id) ... ON CONFLICT DO UPDATE`（第 33-34 行）
  与 `INSERT INTO public.fulfillment_items(...) ON CONFLICT DO NOTHING`（第 35-38 行），
  最后 `UPDATE commerce_orders SET payment_status='paid', order_status='processing', ...`（第 50 行附近）。
  → **收款事实与库存消耗、履约创建在同一事务内**；库存冲突会使整笔回滚，
  正是此前观察到的「payment 停在 processing、order 停在 unpaid」现象来源。
  legacy `commerce_mark_order_paid` 为同族结构。
- **手持接单/拣货只看 paid**：`src/server/handheld-fulfillment.server.ts:122`
  `if (!row.order || row.order.payment_status !== "paid") return { ok: false, code: "order_unpaid" }`。
  只要 `payment_status='paid'` 即放行。
- **写操作阻断清单过窄**：`src/server/handheld-fulfillment-access.server.ts:17`
  `BLOCKING_ORDER_STATUSES = ["cancelled", "closed"]`，在 `:59-68`（write 模式）与 `:266-270`
  （`computePickGuard`）使用。→ 除 cancelled/closed 外，**没有任何「已付款但库存异常」的阻断维度**。
- 领取任务入口：`src/routes/api/public/handheld/fulfillments.$id.claim.ts:23` → `fulfillment_claim_task`；
  详情/拣货完成：`fulfillments.$id.ts:53-58`、`fulfillments.$id.pick-complete.ts:32`，
  阻断判定同样只来自上面的 `order_status` 清单。
- 派生状态：`src/lib/commerce/order-policy.ts:46-62` `deriveOrderStatus`，
  `paid` + 无 fulfillment → `confirmed`，有 fulfillment → `processing`/`completed`。
  该函数**不含任何 hold 概念**。
- 释放：`commerce_release_expired_reservations` 只处理 `reserved` listing 与未支付订单；
  已付款订单不在其范围（此前轮次已核实）。

### 结论（设计含义，非修复）

在当前实现下，一旦 `payment_status='paid'` 写入成功，履约链路（领取→拣货→打包→交接）
**全程没有可用的阻断位**。因此「收款事实与履约阻断解耦」必须同时提供 hold 载体
**和**在上述 write 入口读取该载体，二者缺一不可。

## 2. 订单级 hold 载体：三种取舍

已证实的约束：`fulfillment_exceptions.fulfillment_id` 为 **NOT NULL**（12 列，2 FK）。
→ 扣库存失败、尚未创建 fulfillment 的场景**无法塞入现有异常表**，你的判断成立。

| 方案 | 优点 | 风险 |
|---|---|---|
| A. `commerce_orders` 结构化字段（如 `fulfillment_hold_reason text` + `fulfillment_held_at timestamptz`，均可空） | 改动最小；查询天然随订单；不新建平台；write 入口只需多读两列 | 订单表已 37 列；语义单一，未来多条并发 hold 无法并存；需要明确「谁清除」 |
| B. 独立小表 `commerce_order_holds(order_id, reason_code, created_at, resolved_at, ...)` | 可留痕多条、可审计、不改订单主表；与后续人工处置流程兼容 | 新表需 GRANT/RLS；查询要 join；有「建平台」的观感风险 |
| C. 复用 `metadata` JSON | 零 DDL | 无法建索引/约束，易被覆盖，不适合阻断这类**安全判定**依赖 |

评审意见：**C 不可用于阻断判定**（无约束、可被任意写覆盖）。
A 与 B 的取舍取决于后续是否需要多条 hold 留痕与人工处置按钮；
两者都不要求现在就新增 `order_status` 枚举值——hold 可作为**正交**标记，
主状态继续沿用现有值，避免锁死枚举。**本轮不选定、不写 DDL。**

## 3. 需要成立的不变量（供后续实现时逐条验收）

1. **收款事实不可回滚**：可信 provider 成功事件一旦落库，
   `commerce_payments.status='succeeded'` 与 `commerce_orders.payment_status='paid'` 必须保留；
   库存冲突只允许产生 hold，不得触发自动退款、自动取消、自动上架。
2. **ACK 语义**：仅当外层事务（付款事实 + 内层结果 + hold 持久化）整体提交成功后才向 provider ACK。
   任何未知技术错误**不得**被内层 EXCEPTION 块吞掉伪装成「缺货但成功」；
   只捕获明确的业务库存冲突（需要可判别的 SQLSTATE/错误标识），其余向外抛出，
   让平台重试与查单恢复继续生效。
3. **同订单多支付**：一个订单可能存在多条 payment 记录（重试/换渠道）。
   必须保证最多一条进入 succeeded 并驱动订单 paid；其余在查单/关单时收敛，
   不得因为存在第二条 payment 而重复扣库存或重复建 fulfillment。
4. **事件幂等**：重复回调按 `out_trade_no ↔ merchant_order_no`（退款 `out_refund_no ↔ merchant_refund_no`）
   幂等；`commerce_payment_events` 的事件唯一键必须在**付款事实落库的同一事务**内写入。
5. **迟到 CLOSED / 成功后退款**：已 succeeded 的 payment 收到迟到 CLOSED 必须忽略（不得改回未付款）；
   成功后退款走既有退款链路，且退款**不自动恢复库存或重新上架**（与现状一致）。
6. **hold 与既有阻断的关系**：hold 存在时，write 类履约入口必须拒绝；
   read 类保持可见以便人工排查。hold 的清除只能由后续明确定义的人工操作触发（本轮不定义按钮与权限）。
7. **组合件/多行库存**：一个订单多行、同 SKU 多件或组合件时，内层库存消耗必须**要么整单成功要么整单不消耗**，
   不允许部分扣减后 hold —— 否则 hold 解除时无法判断已扣多少。
   若内层采用行级循环，必须包在可回滚的子事务（SAVEPOINT）内。
8. **锁顺序**：`commit_sale` 与付款路径都锁 SKU/库存行。两条路径必须以**相同顺序**（例如按 sku_id 升序）
   取锁，避免死锁；付款路径的订单行锁应先于库存行锁获取，并在全流程保持一致。
9. **事务边界**：付款事实（payments/payment_events/orders.payment_status）为外层；
   库存消耗 + fulfillment 创建为内层子事务；hold 写入回到外层。
   内层失败时外层已持有的订单行锁不得释放，防止并发再次尝试扣减。

## 4. 方案风险（明确记录）

- 「付款前重查可售与库存」**无法覆盖**发起支付之后、回调之前发生的线下 `commit_sale` 竞态；
  它只降低概率，不能替代第 2 节的 hold 机制。此点与你的判断一致。
- 采用受控异常块的方案，其正确性**完全依赖于「库存冲突」错误可被精确识别**。
  若内层用通用 `RAISE EXCEPTION '...'` 文本判别，任何措辞变化都会让未知错误被误判为缺货。
  实现时应使用专用 SQLSTATE，而非文本匹配。
- 备选方案（先持久化可信事件，再异步履约）需要新的可靠任务与中间态，
  按你的决定**暂不选**，此处仅记录为已评估。
- 现有 `deriveOrderStatus` 与手持 `payment_status !== 'paid'` 判定分布在多处，
  hold 若只加在数据库侧而 TypeScript 侧未读取，则阻断无效——属于最容易遗漏的一环。

## 5. 本轮变更范围

- 唯一修改文件：`.lovable/plan.md`（本设计说明）。
- 未改应用代码、迁移、数据库、权限、配置、cron、roadmap；未部署；未执行支付/库存/有赞写操作。
- 本轮只读命令：`git rev-parse`、`rg` 源码检索、`psql` 只读 `pg_get_functiondef` 摘要与函数体文本检索。
- 以上均为**设计评审与现状事实**，不构成任何「已修复」或「已验收」的结论。
