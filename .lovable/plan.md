# 本任务只读收尾：有赞凭据恢复能力说明 + GO 补录安全合同（修订版）

仅设计与合同修订。未写库、未迁移、未部署；腾讯基线仍为 `1e7a4ee-compressed-images-20260913`。

## 一、有赞凭据恢复：能力边界

- 我可核对名称：`YOUZAN_CLIENT_ID`、`YOUZAN_CLIENT_SECRET`、`YOUZAN_PROXY_URL`、`YOUZAN_PROXY_TOKEN` 四项在 Lovable 安全配置中存在（仅存在性，未读取任何值）。
- 我**没有**导出、同步或直接注入腾讯的能力；值加密存储，我无法读取或转发。
- 我**不会**为取密钥新建任何接口、回显端点或代码路径。
- 我**不断言** Lovable 安全配置面板是否支持显示/复制，也不断言它是唯一来源——这需要你在界面上实际确认。可行来源还包括你方原有密钥保管处（密码管理器/保险库）或有赞原应用配置处。

最短安全路径（由你本人执行）：从你可信的保管来源取值 → SSH 在腾讯服务器编辑器内写入 `shared/.env`（不经命令行参数）→ `chmod 600` → 带 `--update-env` 重载进程 → 只读授权探针确认真实 `code=200` → 单店单窗口有界 canary → 分批开放失败窗口。密钥不进入聊天、日志、命令参数、代码或公开接口。不新建应用，不改权限、退款、租约。

## 二、GO 补录合同（按七项约束修订）

前一版草案作废。已确认的实现缺陷（实读 `src/server/store-targets.server.ts`）：create/void 与审计是分开的 DB 调用；审计 insert 的 error 未检查；幂等是先查后插存在竞态；`voidOfflineEntry` 只按 entry id 更新，无原状态/门店条件。因此合同以数据库端原子操作为前提。

### 1. 原子性
- 创建、作废、审计必须在**同一数据库事务**内完成：改为 `security definer` 的 RPC（如 `store_offline_sales_create` / `store_offline_sales_void`），业务行与 `store_offline_sales_audit_logs` 同事务写入。
- 任一步失败整体回滚；审计写入失败视为整体失败，接口返回错误，**不得返回成功**。
- 应用层不再分两次调用，也不再吞掉审计错误。

### 2. 幂等与并发
- 数据库唯一约束：`store_offline_sales_entries(location_id, client_op_id)` 唯一索引，作为唯一幂等真源（不靠先查后插）。
- 同 `client_op_id` + **同载荷指纹**（对金额/日期/渠道/凭证/排除依据等规范化后哈希，落库为 `payload_fingerprint`）→ 回放原记录，`replayed=true`，返回 200。
- 同 `client_op_id` + **异载荷** → 409 `client_op_id_conflict`，不改写原记录。
- 回放时审计记 `replay_idempotent`，`actor_id` 记录本次调用者，同时保留原记录 `created_by` 不变；两者不得混淆。

### 3. 权限
- 普通门店员工：只能创建、查看、作废**本人创建**且**本人当日排班门店**且 `status='active'` 的记录；不默认授权同店任意员工互删。
- 作废的 RPC 条件必须包含 `id = ? AND location_id = ? AND created_by = ? AND status='active'`，不满足即 0 行影响 → 409/403，不返回成功。
- 总部更正/跨人处理：走既有 ERP 权限流程（`super_admin` / `hq_operator`，Supabase 会话 serverFn），不经 GO JWT 放宽。
- 目标配置写操作权限不变；`/api/public/go/authorization`、`/session`、`/daily-summary` 保持原样。

### 4. 日期与排班
- `business_date` 强制等于服务端计算的 Asia/Shanghai 当日；客户端传入不一致 → 400，不接受补昨天。
- 角色/排班缺失 → 403；当日排班解析出多门店且请求未能唯一确定 → 拒绝（不自动取第一个）。
- 跨午夜：提交时以服务端时刻重新解析当日与排班，不复用客户端会话内缓存的日期或门店。

### 5. 首版范围
- 只支持现金 / POS / 微信收款的**正数**金额（`amount_fen > 0`）。
- 负数、退款、冲账一律拒绝（400），不通过补录隐式开放；退款需求另案，不在本任务内。

### 6. 与有赞去重的真实口径
- `youzan_exclusion_basis` 只是**人工申报**，不是自动去重；系统不会据此比对或剔除有赞订单。
- 日汇总中 `offline` 与 `youzan` 分列，`achieved_fen` 为两者相加，因此错误申报会直接造成重复计入业绩。
- `unverified` 依据的条目必须在汇总中单独可见（计数与金额），并在 `completeness.reasons` 标注存在未核验补录；不得让其静默混入“已核对”的业绩口径。
- `reconciled_against_youzan` 需配 `youzan_excluded_tids`，供事后人工核对，仍不构成自动去重。

### 7. 更正 = 作废 + 重建
- 新记录携带 `supersedes_entry_id` 指向被作废记录，被作废记录记 `superseded_by_entry_id`，形成可追踪链。
- 两步必须在同一事务内完成（同一 RPC）：要么旧作废+新建同时成功，要么全部回滚。
- 失败恢复：事务回滚后原记录保持 `active`，不产生孤儿新记录；同一 `client_op_id` 重试走幂等回放；前端凭 `client_op_id` 安全重试。

### 待确认
- 批准以 RPC + 唯一约束方式实现（需一次迁移）？
- 作废是否限制时窗（例如仅当日可作废，次日起走 ERP 总部流程）？
