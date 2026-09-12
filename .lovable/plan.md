# 只读诊断：auth.audit_log_entries 源端为 0 的证据（2026-09-12，更正版）

本文件为诊断说明的事实更正（依据用户已核实材料）。本轮操作范围：仅修改本说明文件。
未修改应用代码/数据库/配置/权限/cron，未发布，未执行导出，未执行任何支付操作，
未新建任何数据出口。精确 commit：`ec1de47acafbf6a46e421de464a51f40c8adef5f`（诊断执行时）。

## 变更如实声明

- 上一轮我曾声称「本轮无任何修改」，实际我写入了 `.lovable/plan.md`（诊断说明文件）并生成了
  commit `2231409bb92bfe0b2e243cf98d52e7f65418ecee`。该声明不准确，在此更正：
  此前（以及本轮）均无应用代码、数据库、配置、权限、cron 或生产环境变更；
  唯一变更对象是 `.lovable/plan.md` 这份计划/诊断说明文档本身。

## 1. 源端是否存在清理审计日志的机制

### 已证实（只读查询/文件检索）

- 源库 `auth.audit_log_entries`：`count(*) = 0`，`min/max(created_at) = NULL`。
- 表物理大小：heap `0` 字节，`pg_total_relation_size = 24576`。
- `pg_stat_all_tables`（统计自 `stats_reset = 2026-05-07 18:19:10+00`）：
  `audit_log_entries` 的 `n_tup_ins = 0`、`n_tup_del = 0`、`n_live_tup = 0`。
  同期同 schema 有真实写入：`refresh_tokens` ins 989 / del 310，`sessions` ins 33，
  `users` ins 21，`mfa_amr_claims` ins 33。
  → 该统计窗口内登录活动存在，审计表无插入计数。此为事实记录，**不构成对原因的证明**（见「未知」）。
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

### 更正：删除此前的确定性推断

此前版本写「GoTrue 登录必写审计」「与表曾被 TRUNCATE 一致」。此推断**不成立**，撤回：

- Supabase 官方文档（https://supabase.com/docs/guides/auth/audit-logs）明确：
  数据库 `audit_log_entries` 的写入是**可选、可禁用**的；
  官方 auth 源码 `AuditLogConfiguration.DisablePostgres` 对应环境变量
  `GOTRUE_AUDIT_LOG_DISABLE_POSTGRES`。
- 因此 0 行/0 堆/0 统计**同样与「该实例审计写入被禁用」相容**，
  无法据此证明 TRUNCATE，也无法证明曾被清空。

### 不可见 / 未知

- 本连接的受限角色对 `auth` 与 `cron` schema 无 SELECT 权限
  （当前角色 `sandbox_exec`，非 superuser）。GoTrue 侧配置（含上述开关）不在本库与本仓库内。
- 「该表为何为 0」**原因未知**：候选解释至少包括（a）审计写入始终被禁用；
  （b）平台/运维侧曾清理；两者无法用现有证据区分。
- Codex 已在腾讯独立环境解码官方原始备份
  （SHA256 `f11c0c02034a3a059e340acd33e370be6bf800a81657d0e98c079d2e5043d3d6`，9,644,176 字节），
  其中 `auth.audit_log_entries` COPY 块为 **0 行**——即官方导出时刻源端即为 0。
- 腾讯候选的 103 行审计记录产生于该原始备份之后（2026-09-09 至 2026-09-10）；
  其中 63 行 `actor_username` 以 `@example.invalid` 结尾，与当前 `auth.users` 的 actor 匹配数为 0
  （仅聚合口径，无 PII）。
- **不从源端 0 行判定历史丢失，不删除候选审计记录。** 参考：源端 `auth.users` 共 4 行，
  `max(last_sign_in_at) = 2026-09-07 17:01:26+00`，`max(updated_at) = 2026-09-12 08:23:08+00`。

## 2. 源端现有的一致性导出机制（更正：序列非原子一致）

- 单库 `pg_dump` 在一个快照内导出**表数据**，同库内 `auth`/`storage`/`public` 的表间一致性成立。
- **更正**：此前版本写「序列 last_value 随表天然原子一致」，此说法**不准确**，撤回。
  官方 PostgreSQL 17 文档（functions-sequence）明确 `nextval`/`setval` 不受普通事务回滚保护；
  序列状态不属于 MVCC 快照。`pg_dump` 以 `setval` 形式记录序列值，但该值取自导出执行时刻，
  与快照内表数据**不保证原子一致**；导出期间若有并发 `nextval`，序列高水位可能领先于表数据。
- 因此最终一致性导出必须：**先停写、停后台任务**，再导出，并在导出后**单独核对两端序列**
  （含 `is_called` 标志与高水位；只前进、不倒退）。
- 角色需用 `pg_dumpall --roles-only` 单独导出，属另一个快照；角色为低频对象，可接受。
- 仓库内唯一现成脚本 `infra/tencent-supabase/ops/backup.sh:24-39`
  （`pg_dumpall --roles-only` + `pg_dump --format=custom --no-owner --no-privileges` + SHA256，
  由 `ops/systemd/boomer-data-backup.timer` 每日 03:20 Asia/Shanghai 驱动）作用于**腾讯栈容器**，
  不是源生产库，且 `--no-owner --no-privileges` 丢弃属主/ACL，不适合直接作为源端权威导出。
- 本沙箱角色无法执行源端 `pg_dump`（非 superuser、无 auth schema 读权限），
  平台不提供 service role / 数据库口令。
- 官方 Export data 路径已有 2026-09-09 成功下载并成功恢复的证据（即上述 SHA256 备份），
  **本轮不新建出口、不执行导出、不申请凭证，也不要求重新决定是否保留已有记录。**
- 源库 `wal_level = logical`（支持逻辑复制类方案），`track_commit_timestamp = off`
  （无法用提交时间戳做行级增量水位）。

## 3. 本轮执行清单

- 只读命令：`git rev-parse` / `git status`、`rg`/`sed` 源码检索、只读 `SELECT`
  （`pg_stat_all_tables`、`pg_class`、`pg_settings`、`pg_trigger`、`cron.job`、
  `auth.audit_log_entries` 聚合、`auth.users` 聚合）——以上来自此前诊断轮，本轮未新增数据库访问。
- 本轮唯一写操作：`.lovable/plan.md` 本文件的事实更正。
- 未执行 DDL/DML、未改 cron、未发布、未导出、未操作支付。
- 资金异常规则与正式停写窗口仍未获确认，未实现任何相关逻辑。
- 说明：原计划登记本轮任务到 `roadmap.md`，但当前模式仅允许写本说明文件，该登记未执行。

## 待你确认的下一步（本轮不执行）

1. 是否需要我继续只读追查平台侧可见的 Auth 日志线索（analytics 日志中的 auth 事件计数，仅聚合）？
2. 序列核对方案（停写后比对 `is_called` 与高水位）是否纳入最终切换清单？
