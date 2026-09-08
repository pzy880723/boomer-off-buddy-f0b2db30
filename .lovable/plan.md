# 客服顾客上下文迁移：只核对与记录（不重复执行）

Codex 已通过 Lovable query_database 直接执行同名 SQL（含两个 RPC），API 代码本地提交 221a88e。本次只做只读核对与结果记录，不改代码、不迁移、不发布腾讯。

## 只读核对结果（已执行）

函数与权限：
- `support_customer_conversation_list(uuid)`、`support_customer_mark_read(...)` 均存在，均为 SECURITY INVOKER（prosecdef=false）。
- EXECUTE 权限：anon=否、authenticated=否、service_role=是，两个函数均符合预期。

表与 RLS：
- `support_customer_reads`：RLS 已开启，策略 1 条。
- `support_conversations.context_key` 唯一索引生效（当前 1 行带 context_key）。

数据水位：
- support_conversations=1、support_messages=1、support_customer_reads=1。
- 唯一一行：2026-09-08 07:57 UTC 创建，sender_type=system、internal=false、status=open，带 context_key 和已读水位。
- 与你说的「剩余 test customers=0」存在出入：这行可能是会话创建时自动写入的系统消息（正常现象），也可能是事务验证的残留。未读取任何消息正文，未接触真实顾客数据。

未核实项（受权限/范围限制）：
- 事务内行为验证（unread 2→1→0、水位不倒退、跨客拒绝）由你在真实事务 rollback 中确认通过，本次未重复构造测试数据。
- 迁移是否登记在平台迁移记录表（Codex 直连执行通常不会留下 migration 文件记录）。

## 后续动作

1. 请你确认那唯一一行会话是否为系统正常创建（例如首会话的 system 欢迎消息）。若是残留测试数据，告知后我再处理；否则无需任何动作。
2. 若需要在平台迁移记录中补记 `20260908030717_support_customer_context_reads.sql`，需你确认后由我用迁移工具提交一条只含注释/登记用途的记录（不重复 DDL）；如不需要补记，此项跳过。
3. 腾讯发布、小程序前端（BOOMEROFF repo）均不在本次范围，保持不动。

## 技术细节

- 核对均通过只读查询完成，未写入任何数据。
- 本次无代码改动、无迁移、无发布。
