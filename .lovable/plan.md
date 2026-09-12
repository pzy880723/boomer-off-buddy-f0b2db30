# 只读诊断：auth.audit_log_entries 源端为 0 的证据（2026-09-12）

本轮只读：未修改代码/数据库/配置/权限/cron，未发布，未创建导出文件，未申请凭证，未输出连接串、payload、user id、IP、令牌。
精确 commit：`ec1de47acafbf6a46e421de464a51f40c8adef5f`，工作区干净（`git status --porcelain` 空）。

## 1. 源端是否存在清理审计日志的机制

### 已证实（只读查询/文件检索）

- 源库 `auth.audit_log_entries`：`count(*) = 0`，`min/max(created_at) = NULL`。
- 表物理大小：heap `0` 字节，`pg_total_relation_size = 24576`（只剩索引/元数据页）。
- `pg_stat_all_tables`（统计自 `stats_reset = 2026-05-07 18:19:10+00`）：
  `audit_log_entries` 的 `n_tup_ins = 0`、`n_tup_del = 0`、`n_live_tup = 0`。
  同期同 schema 有真实写入：`refresh_tokens` ins 989 / del 310，`sessions` ins 33，
  `users` ins 21，`mfa_amr_claims` ins 33。
  → 同一统计窗口内登录活动明确存在，但审计表插入计数为 0 且堆为 0 字节。
  这与「该表被 TRUNCATE（TRUNCATE 会重置该表的 ins/del 计数并释放堆）」一致；
  与「从未产生过审计行」不一致（GoTrue 登录必写审计）。
- 触发器：`auth.audit_log_entries` 与 `auth.refresh_tokens` 上无非内部触发器（查询返回空）。
- cron：`cron.job` 共 5 条，均为业务 HTTP 任务
  （youzan-sync-30min=false、youzan-stock-worker-tick、channel-sync-worker-tick、
  commerce-release-expired-every-minute、listing-image-worker-every-minute），
  无任何涉及 auth/审计清理的任务。
- 仓库：`rg` 全仓未命中任何 `auth.audit_log_entries` 引用；
  `supabase/migrations/*.sql` 无 `TRUNCATE`、无 `DELETE FROM auth.`、无 `auth.audit` 命中。
  仓库内所有 `audit_log` 命中均为业务表
  （`public.store_development_audit_logs`、`public.user_scope_audit_logs`、
  `public.store_target_audit_logs`、`public.store_offline_sales_audit_logs`），与 auth 无关。
- `supabase/config.toml` 内无 retention/audit 配置项。

### 不可见 / 未知

- 本连接的受限角色对 `auth` 与 `cron` schema 无 SELECT 权限
  （`permission denied for schema auth` / `for schema cron`；当前角色 `sandbox_exec`，非 superuser）。
  行级证据只能通过受管只读工具取聚合值，无法读取 GoTrue 侧配置。
- 平台侧（托管 Auth 服务）的日志保留策略、`GOTRUE_*` 环境变量、平台维护作业不在本库与本仓库内，
  **无法证实也无法排除**。
- 因此「谁在何时清空了该表」**原因未知**：数据库内无触发器、无 cron、无迁移、无应用代码可解释，
  证据只支持「表曾被截断且发生在数据库外部（平台或运维侧）」这一推断，不构成证实。
- 参考时间：`auth.users` 共 4 行，`max(last_sign_in_at) = 2026-09-07 17:01:26+00`，
  `max(updated_at) = 2026-09-12 08:23:08+00`。候选 103 行的区间（09-09 → 09-10）晚于源端最后登录时间，
  其归属需由腾讯侧证据判定，不能由源端 0 行反推候选无效。

## 2. 源端现有的一致性导出机制

- 单库 `pg_dump` 在**一个快照**内导出，天然覆盖同库内 `auth`/`storage`/`public`
  的表数据、序列 `last_value`（作为 `setval` 写入），一致性成立。
  角色需用 `pg_dumpall --roles-only` 单独导出，**属于另一个快照**，但角色为低频对象，可接受。
- 仓库内唯一现成脚本是 `infra/tencent-supabase/ops/backup.sh:24-39`：
  `pg_dumpall --roles-only` + `pg_dump --format=custom --no-owner --no-privileges` + SHA256 校验，
  由 `ops/systemd/boomer-data-backup.timer`（每日 03:20 Asia/Shanghai）驱动。
  该脚本作用于**腾讯栈容器**，不是源生产库，且 `--no-owner --no-privileges` 会丢弃属主/ACL，
  不适合直接作为源端权威导出。
- 本沙箱角色无法执行源端 `pg_dump`（非 superuser、无 auth schema 读权限），
  平台亦不提供 service role / 数据库口令。可用的官方路径是 Cloud → Advanced settings → Export data，
  以及 Storage 侧单独的对象复制；**本轮不执行、不申请**。
- 源库 `wal_level = logical`（支持逻辑复制/快照导出类方案），`track_commit_timestamp = off`
  （无法用提交时间戳做行级增量水位）。

## 3. 修改情况

本轮无任何修改。执行的仅为：`git rev-parse` / `git status`、`rg`/`sed` 源码检索、
只读 `SELECT`（`pg_stat_all_tables`、`pg_class`、`pg_settings`、`pg_trigger`、`cron.job`、
`auth.audit_log_entries` 聚合、`auth.users` 聚合）。未执行 DDL/DML、未改 cron、未发布。
资金异常规则与正式停写窗口仍未获确认，本轮未实现任何相关逻辑。

## 待你确认的下一步（本轮不执行）

1. 候选 103 条审计历史：保留（推荐，源端 0 无法证明其无效）还是另行判定？
2. 是否需要我继续只读追查平台侧可见的 Auth 日志线索（analytics 日志中的 auth 事件计数，仅聚合）？
