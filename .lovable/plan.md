# 只读复核：20260831220000_marketplace_payment_foundation.sql（修订版）

本轮**未执行任何写操作**：未运行 migration、未 DDL/DML、未发布、未改任何生产代码。结论来自与上一版 SQL 的逐行 diff、全文静态阅读，以及对生产库的只读查询（information_schema / pg_proc / pg_constraint）。

## 1) v1 过渡期是否仍可写 — 是，已修好

修订版删除了会打断 v1 的三处：不再 `DROP` 旧唯一键 `commerce_payment_suborders_payment_id_payment_profile_id_key`、不再把 `payment_profile_id` 改为可空、不再对三个 fen 列 `SET NOT NULL`。

只读核对生产列定义：`payment_profile_id NOT NULL`、`allocation_snapshot jsonb NOT NULL DEFAULT '{}'`。因此 v1 的 INSERT：

- 三个 fen 列留 NULL → `line_amount_fen >= 0`、`amount_fen >= 0`、`decimal_fen_match` 三个 CHECK 在 NULL 下求值为 NULL，Postgres 视为通过；
- `allocation_snapshot` 取默认 `'{}'`，不含 `store_allocations` 键 → 落在新 partial unique index 的谓词之外，不会与 v2 的按主体唯一冲突。

结论：v1 与 v2 可真正并存，`payments.ts:258` 无需同批改动。

## 2) v2 的四项校验

- **partial unique**（第 151–153 行）：谓词 `amount_fen IS NOT NULL AND allocation_snapshot ? 'store_allocations'`。`jsonb_exists` 与 `round` 均为 IMMUTABLE（已查 pg_proc，provolatile='i'），索引谓词合法。
- **fen 校验**：v2 显式拒绝三个 fen 为 NULL，并逐条断言 `fen = round(decimal*100)`，与表级 `decimal_fen_match` 双保险，正确。
- **子单总额校验**（第 495–501 行）：`sum(amount_fen) = round(payments.amount*100)`，覆盖了 1 分差场景，正确。
- **normalized profile relation**：`commerce_payment_suborder_profiles` 建表 + 存量回填 + v2 内 `FOREACH` 写入全部 contributing profiles，并先校验这些 profile 全部属于同一 active 主体且 `wechat_sub_mchid` 一致，正确。

**阻断项 B1（唯一一项）**：v2 只校验 `allocation_snapshot` 是 object，**没有要求它包含 `store_allocations` 键**。一旦调用方传入不含该键的快照，这条 v2 子单就不在 partial unique index 覆盖范围内，"同一 payment 同一主体只能有一条子单"的保护被静默绕过，且明细表里也失去门店维度依据。修法二选一：在 v2 里加 `IF NOT (v_suborder.allocation_snapshot ? 'store_allocations') THEN RAISE EXCEPTION`，或把索引谓词简化为只看 `amount_fen IS NOT NULL`（v1 恒为 NULL，同样能区分两代）。建议前者。

## 3) 时间戳

生产仓库当前最大迁移为 `20260831213000_hello_kitty_specific_ip.sql`；新文件 `20260831220000` 严格晚于它，顺序正确。上一版的 B3 已解决。

## 4) 个人/小微身份及同名结算约束

新增 `identity_verification_reference`、`settlement_account_verified_at` 两列；触发器新增第四段：`provider_application_status='active'` 且 `subject_type IN ('micro_merchant','personal_seller')` 时，强制 `seller_qualification_status='approved'` + 身份核验引用非空 + 结算账户核验时间非空。加上原有的自助进件（owner + 协议版本 + 接受时间）校验，个人/小微不可能在零身份信息下被置为 active。上一版第 8 条缺口已闭合。

同名收款：新增 `COMMENT ON COLUMN payment_subjects.wechat_sub_mchid` 明示"禁止用消费者 OpenID 作为收款方"。这是文档级表达，非强制约束——真正的执行点仍在 provider 层（只接受 `wechat_sub_mchid`）。可接受，记为已知非 schema 级约束。

## 5) 其余 SQL/schema 问题

**非阻断（建议但不影响本次执行）**

1. **仍不可重跑**：第 81/97/155/177/215/240/260/276/297 行 9 处 `CREATE TABLE`、第 128/174/209/212/236/312 行 6 处 `CREATE INDEX`、第 142–144 行 3 处 `ADD CONSTRAINT`、第 151 与 290 行两处新唯一索引均无 `IF NOT EXISTS` / 前置 DROP。首跑没问题（9 张表在生产均不存在，三个约束名也不存在），部分失败后重跑会报 42P07/42710。若走单事务（本文件全部为事务性 DDL，无 CONCURRENTLY），失败整体回滚，风险可控。
2. **`?` 操作符**：第 153 行在部分 SQL 客户端/驱动里 `?` 会被当作参数占位符。经 migration 工具/psql 执行没问题，但若日后经 JS 驱动重放需注意，可改写为 `jsonb_exists(allocation_snapshot, 'store_allocations')` 规避。
3. **对账去重已修好**：改成 `coalesce(...,'')` 的表达式唯一索引 + `CHECK (provider_transaction_id IS NOT NULL OR provider_reference IS NOT NULL)`，NULLS DISTINCT 问题已解决。
4. **`platform_commission_rules` 仍无"同 scope 时间区间不重叠"保护**：`UNIQUE(rule_code, version)` 挡不住两条 platform 默认规则同时 active。建议加部分唯一索引或 `EXCLUDE USING gist`。
5. **ledger 写入入口未定义**：`commerce_settlement_ledger` 目前没有任何 RPC 写它，若应用层直写会让快照不可信。建议下一阶段用单一 RPC 收口。
6. **`location_ids jsonb`** 在 v2 的 `jsonb_to_recordset` 里声明但未使用，可删或并入 allocation_snapshot。
7. **前端仍挡个人主体**：`src/lib/store-payments.functions.ts` 的 zod 仍要求统一社会信用代码 ≥15 位，本阶段不改 UI，记为已知缺口。
8. 建议为本迁移新增一个契约测试（参考 `src/lib/commerce/schema-contract.test.ts`），断言 partial unique 谓词、fen 校验与总额校验文本。

## 结论

上一版的 B1（v1 失效）、B3（时间戳）、以及第 6/8 条建议均已解决。**当前唯一阻断项是 B1：v2 未强制 `allocation_snapshot` 含 `store_allocations` 键，导致按主体的唯一性保护可被绕过。** 修掉这一处后即可执行；B4（幂等）为工程卫生建议。

再次确认：本轮未执行 migration、未写数据库、未发布、未修改任何生产代码。
