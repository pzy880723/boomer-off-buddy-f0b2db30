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

## 1b. 履约写入口逐条盘点（有界只读；未实施任何改动）

盘点范围（有界检索，非全覆盖）：`src/routes/api/public/handheld/`（`ls | head -60` 所见 60 个文件，
**不代表**该目录仅有这 60 个）、`src/lib/commerce-operations.functions.ts`、
`src/routes/orders.*.tsx`、`src/server/handheld-*`，以及上述入口调用到的 DB 函数定义
（只读 `pg_get_functiondef`，未调用任何业务函数）。
「未找到」仅表示在本次有界检索中未发现，不等于不存在。

| 类别 | 入口（文件:行 / 方法） | 写入的 RPC / 表 | 当前鉴权 | 当前业务阻断 | 拟插入 hold 检查处 |
|---|---|---|---|---|---|
| 领取任务 | `fulfillments.$id.claim.ts:16` POST | RPC `fulfillment_claim_task`（UPDATE fulfillments allocated→picking） | `authenticateDevice` + `requireLocation`；`resolveSessionUser` 仅用于取 operator，**operator 可空、非强制登录**；**未**调用 `authorizeFulfillment` | 仅 RPC 内 `status IN ('allocated','picking')`，**无任何订单状态校验** | RPC 内（首选，因 TS 侧无 access 检查）+ 路由层 |
| 绑框 | `fulfillments.$id.bind-tote.ts:19` POST | RPC `fulfillment_bind_tote` | `authenticateDevice` + `requireLocation`；**无 resolveSessionUser**（不能写成「鉴权同 claim」）；**未**调用 `authorizeFulfillment` | RPC 内仅校验 fulfillment 状态与 tote 占用，**无订单校验** | RPC 内 |
| 拣货扫码 | `fulfillments.$id.pick-scan.ts:23` POST | RPC `fulfillment_pick_scan` | `authorizeFulfillment(mode:"write")` | TS 侧 `BLOCKING_ORDER_STATUSES`（cancelled/closed）；RPC 内仅 `status IN ('allocated','picking')` | RPC 内 + `authorizeFulfillment` |
| 拣货完成 | `fulfillments.$id.pick-complete.ts:16` POST | RPC `fulfillment_complete_pick` | `authorizeFulfillment` + `loadPickGuard` | TS 侧 `order_status_unavailable` / `pick_blocked`；**RPC 内除 `order_status IN ('cancelled','closed')` 外，还阻断 `pending_customer`、`refund_pending`、`unpicked`（不能写成仅阻断 cancelled/closed）**；是本轮唯一在 DB 侧有订单校验的履约 RPC | 与 RPC 内既有订单校验同处扩展 |
| 缺货上报 | `fulfillments.$id.shortage.ts:27` POST | 直接写 `fulfillment_items`(读) / `fulfillment_shortages`(插/改) / `fulfillment_exceptions`(插) | `authorizeFulfillment(mode:"write")` | 仅行归属校验 + TS 侧阻断清单 | 路由层（无对应 RPC） |
| 票据读取 | `fulfillments.$id.ticket.ts:16` GET | 只读（`buildFulfillmentTicket`） | `authorizeFulfillment` | — | **不需 hold 阻断**：这是读取，不是领取写入 |
| 面单/快递发货 | `fulfillments.$id.waybill.ts:30` GET（读 `shipments`）、`:55` POST | POST 目前**无写入**，返回 409 `carrier_not_configured` 或 501 `carrier_not_implemented` | `authorizeFulfillment` | 承运商未接入 | 未来接入时在写 `shipments` 前 |
| 撤销拣货 | **未找到** | — | — | — | — |
| 打包扫码 / 打包完成 | **未找到**（`packing`/`packed` 仅出现在类型定义、`handheld-orders.server.ts:32-35` 的状态枚举与 `operational-dashboard.server.ts:222` 的统计） | — | — | — |
| 交接 / 带走 / 自提 | **未找到**（`handed_over` 同上，仅枚举与统计） | — | — | — |
| 手动状态更新（后台页） | **未找到**履约状态写入；`src/routes/orders.dispatch.tsx:13` 仅 GET 列表；`src/lib/commerce-operations.functions.ts` 内只有 `transitionCommerceAfterSale:138`（RPC `commerce_transition_after_sale`，售后状态，非履约） | — | serverFn | — | 售后流程后定，本轮不涉及 |
| 自动完成 | **未找到**自动置 `handed_over`/completed 的任务 | — | — | — | — |
| 创建履约 / 拣货票据任务 | `commerce_mark_ordinary_order_paid` / `commerce_mark_order_paid` 函数体内 INSERT `fulfillments` + `fulfillment_items`；触发器 `tg_fulfillment_enqueue_pick_ticket` | — | 仅 service_role | 无 | 内层子事务失败即写 hold（见第 3 节） |
| 缺货确认 / 退款 | **未找到**「缺货确认后自动退款」路径；退款走既有普通支付退款链路 | — | — | — | 不自动退款（设计约束） |

### 是否存在绕过 TS 检查的直连 RPC 路径

只读权限核对（`pg_proc.proacl`、`has_function_privilege`、`has_table_privilege`）：

- 函数级：只读 `has_function_privilege` 核验了 **6 个函数名、共 7 个签名**
  （`fulfillment_pick_scan` 存在两重载），结论为这 7 个签名上
  anon / authenticated 的 EXECUTE 均为 **false**；`proacl` 中亦无 anon/authenticated 条目。
  **该结论只覆盖这 7 个签名，不能宣称整个 Data API 无绕过路径。**
- 表级：更正此前结论 —— 经根端 `has_table_privilege` 核验，
  `fulfillments`、`fulfillment_items`、`fulfillment_shortages`、`fulfillment_exceptions`、
  `shipments`、`commerce_orders` 6 表对 anon 和 authenticated 的
  SELECT / INSERT / UPDATE / DELETE **均为 true，且 6 表 RLS 均开启**。
  此前 `information_schema.role_table_grants` 只反映本沙箱角色可见的授权，
  **不足以得出「无表级授权」，该结论已撤回**。
  表级 grant 存在 ≠ 实际可操作：能否真正读写取决于 RLS 策略、调用方角色身份及其他写入口，
  需逐表评估，本轮未逐条核对 6 表的全部策略。
- 结论（收窄）：函数侧已核实这 7 个签名不能被 anon/authenticated 直接调用；
  表侧存在 anon/authenticated 授权，是否可绕过 `authorizeFulfillment` 直接写表
  取决于 RLS 策略细节，**属于待核查项，不再断言**。
- 另外：`claim` 与 `bind-tote` 两个路由本身不做订单级判定，
  若 hold 只加在 TS 侧的 `authorizeFulfillment`，这两条路径仍会漏过 —— 所以 hold 判定应下沉到 RPC 内。
- 竞态不变量：hold 的判定必须与产生写入的变更**在同一事务内**并遵循统一锁顺序；
  仅在 TS 侧「先读 hold、再发 RPC」存在读—写竞态，不构成阻断。

### 两点澄清（按你的要求）

- `buildFulfillmentTicket`（`fulfillments.$id.ticket.ts` GET）是**票据读取**，不是领取写入，
  不应被当作需要 hold 阻断的写入口。
- `fulfillment_exceptions` 是**单个履约单**的异常记录（`fulfillment_id` NOT NULL），
  **不能**当作全局/订单级 hold 使用。

正常路径与真实线下事件必须保留：hold 只阻断「已付款但库存冲突」的订单，
不改变其余订单的正常领取/拣货/完成流程。



## 2. 订单级 hold 载体：三种取舍

已证实的约束：`fulfillment_exceptions.fulfillment_id` 为 **NOT NULL**（12 列，2 FK）。
→ 扣库存失败、尚未创建 fulfillment 的场景**无法塞入现有异常表**，你的判断成立。

| 方案 | 优点 | 风险 |
|---|---|---|
| A. `commerce_orders` 结构化字段（如 `fulfillment_hold_reason text` + `fulfillment_held_at timestamptz`，均可空） | 改动最小；查询天然随订单；不新建平台；write 入口只需多读两列 | 订单表已 37 列；语义单一，未来多条并发 hold 无法并存；需要明确「谁清除」 |
| B. 独立小表 `commerce_order_holds(order_id, reason_code, created_at, resolved_at, ...)` | 可留痕多条、可审计、不改订单主表；与后续人工处置流程兼容 | 新表需 GRANT/RLS；查询要 join；有「建平台」的观感风险 |
| C. 复用 `metadata` JSON | 零 DDL | 当前读写边界、覆盖风险与契约不明确，不适合阻断这类**安全判定**依赖 |

评审意见：**C 不可用于阻断判定**（当前契约与写边界不可控，可被任意覆盖）。
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
 3. **同订单多支付**：若渠道真实发生两笔及以上成功，必须**保留全部真实收款记录**；
    最多仅由其中一笔驱动履约一次，其余转为人工异常处理，**不自动退款、不静默关单**。
    不得用数据库约束把第二笔真实到账拒之门外来假装只有一笔成功。
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
