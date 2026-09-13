# 原生 GO 收尾：门店目标 + 线下补录 集成合同核实

只读核实完成，未改代码、未恢复队列、未部署腾讯。腾讯运行基线仍为 `1e7a4ee-compressed-images-20260913`；本仓库 HEAD `6cef4bb`（仅 plan 文件），代码基线对应 main。

## 一、现状实查证据（当前代码 / 内嵌库）

### 1. 月目标 → 日目标

| 层 | 位置 | 事实 |
|---|---|---|
| 表 | `store_monthly_target_plans`（版本 + published/archived）、`store_daily_targets`（唯一键 `location_id,target_date`，含 `source`/`is_locked`/`plan_version`）、`store_target_audit_logs` | 迁移 `20260907102650_...`、`20260907104254_...` 已应用（库内最新 version `20260908081317`）。实查：plans 2 条、daily_targets 21 条 |
| 分配逻辑 | `src/lib/store-targets/allocation.ts` + `src/server/store-targets.server.ts::publishMonthlyPlan` | 过去日与 `is_locked` 日冻结不覆盖，只 upsert 未冻结日；每次发布归档旧 published 并写审计 |
| 日目标改写 | `overrideDailyTarget` | `source='manual_override'`，默认 `is_locked=true`，必须带 `reason`，写审计 |
| ERP API | `src/lib/store-targets.functions.ts`：`listTargetLocations` / `getMonthlyTargetPlan` / `publishMonthlyTargetPlan` / `setDailyTargetOverride` / `getStoreDailySummary` / `listTargetAuditLogs` | 全部 `createServerFn` + `requireSupabaseAuth`。写操作 `requireHq()` 仅 `super_admin`/`hq_operator`；`getStoreDailySummary` 额外允许 `user_location_perms` 命中的门店 |
| ERP 配置页 | `src/routes/shop-mgmt.targets.tsx` | 已接月计划发布、日目标覆盖、当日汇总、审计列表；**页面没有任何线下补录 UI** |

结论：月目标→日目标链路完整，且**只能用 ERP 登录（Supabase 会话）调用**，GO JWT 无法调用这些 serverFn。

### 2. 日汇总对外接口（GO 本人 JWT 可用）

- `GET /api/public/go/daily-summary?date=&location_id=`
- `GET /api/public/go/store/daily-sales?date=&location_id=`（同一套鉴权与口径的别名）
- `GET /api/public/go/authorization`、`POST /api/public/go/authorization-ack`、`/api/public/go/session`

鉴权：`authenticateGoActor()` 只接受固定 GO issuer（`GO_SUPABASE_ORIGIN`，`GO_SUPABASE_URL` 需同源）的用户 Bearer JWT，走 GO `auth.getUser` 实查，不本地 decode；门店由 GO 排班 + ERP `go_shop_location_links` 决定，忽略客户端声明；越权 403，未配置 503 `go_bridge_not_configured`。

返回（`ok:true,data`）字段口径：`target_fen`/`target_source`、`achieved_fen`、`gap_fen`、`progress_pct`、`youzan{performance_fen,gross_paid_fen,shipping_fee_fen,order_count,excluded_order_count,shop_bound}`、`offline{amount_fen,entry_count,order_count}`、`completeness`。金额整数分；无退款源时 `kind="paid_gross"`、`complete=false`。

这三条 GO 接口本轮必须保留原样。

### 3. 线下补录现状

- 表 `store_offline_sales_entries`（22 列，3 policies）+ `store_offline_sales_audit_logs`；实查行数 0（从未写过真实补录）。
- 服务端实现 `src/server/store-targets.server.ts`：`createOfflineEntry`（幂等：同门店同 `client_op_id` 回放原记录并写 `replay_idempotent` 审计）、`listOfflineEntries`、`voidOfflineEntry`（必须 `reason`，改 `status='voided'` 并写审计）。
- 唯一已接的 API：`/api/public/handheld/store/offline-sales`（GET 列表 / POST 新增），鉴权是 **手持设备令牌 + 员工会话**（`authenticateDevice` + `resolveSessionUser` + `userCanAccessLocation`），不是 GO JWT。
- 防有赞重复靠申报字段：`youzan_exclusion_basis` ∈ `device_not_youzan|operator_declared|reconciled_against_youzan|unverified`，加 `youzan_excluded_tids[]`；除 `manual_declaration` 外必须给 `evidence_ref` 或 `evidence_url`。

## 二、确认的缺口（不是未知，是实查缺失）

1. **GO 端无补录入口**：原生已有每日目标卡，但补录只有手持设备通道；GO 本人 JWT 打不通 `createOfflineEntry`。
2. **无“改正”API**：`store-targets.server.ts` 只有 create / void / list，没有 correct/amend；ERP 与手持均无。
3. **`voidOfflineEntry` 没有任何路由调用**（全仓仅定义处出现），作废能力目前不可达。
4. **ERP 端无补录审阅页**：`shop-mgmt.targets.tsx` 无补录列表/作废/改正 UI。
5. **幂等键无库级唯一约束证据**：现为应用层先查后插，`client_op_id` 并发重复需确认唯一索引，否则可能双写。

## 三、GO 授权 8 秒上游调用 / 9 月 8 日两次 erp_timeout

- 超时常量在 `src/server/trusted-go-fetch.server.ts`：`GO_FETCH_TIMEOUT_MS = 8_000`，覆盖响应头之后的 body 读取，并与调用方 `request.signal` 联动 abort。
- 后续修复已存在：`74233cc`（2026-09-08）`fix: harden GO issuer transport and disable response caching`，测试 `src/server/trusted-go-fetch.test.mjs` 断言 8000ms 计时覆盖 body 阶段与外部 abort 传播。
- 内嵌库 `go_authorization_snapshots` 只有 1 条（2026-09-07），无 erp_timeout 记录；9 月 8 日两次超时属腾讯运行侧事实，本库无法核对。
- 本轮不放宽权限、不改租约、不改超时值。

## 四、建议的最小接法（需你批准后才实施）

不新建 App 独立后台，只补三件事：

1. **GO 本人 JWT 补录通道**：新增 `POST /api/public/go/store/offline-sales`，复用 `authenticateGoActor` + `scopeForActor`（门店由排班/映射决定，忽略 body 的 location_id），body 与手持端同构（`client_op_id`、`amount_fen`、`channel`、`evidence_*`、`youzan_exclusion_basis`），内部调用同一 `createOfflineEntry`，不新增业务逻辑分支。
2. **改正与作废**：新增 `POST .../offline-sales/:id/void`（复用 `voidOfflineEntry`，必填 reason）；“改正”按 void + 新建（保留原始审计链）实现，不做原地改金额。
3. **幂等硬化**：为 `store_offline_sales_entries(location_id, client_op_id)` 加唯一索引，并在冲突时回放原记录（迁移需单独批准）。

权限边界保持：目标配置写操作仍只限 ERP 总部角色；GO 侧只能就自己排班门店补录与查看。

## 五、待你确认

- 是否批准上述 GO 补录/作废路由与唯一索引迁移？
- 补录是否允许负数金额（当前只禁 0）？
- “改正”是否接受 void+重建，而非原地修改？
