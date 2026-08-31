# 只读审查：20260831120000_marketplace_payment_foundation.sql

本轮**未执行任何写操作**：没有运行 migration、没有 INSERT/UPDATE/DELETE、没有 DDL、没有发布、没有修改任何生产代码。全部结论来自对生产 schema 的只读查询（information_schema / pg_constraint / count）与对附件 SQL 全文（491 行）的静态阅读。

## 核对到的生产事实

- 约束名全部命中：`payment_subjects_subject_type_check`、`payment_subjects_unified_social_credit_code_key`、`commerce_payment_suborders_payment_id_payment_profile_id_key` 均存在且拼写一致 → `DROP CONSTRAINT` 全部有效。
- `commerce_customers`、`inv_locations`、`commerce_orders`、`commerce_payments`、`commerce_refunds`、`store_payment_profiles` 均存在；`tg_set_updated_at()` 存在 → 5 处 CREATE TRIGGER 可用。
- 行数：payment_subjects 0、commerce_payment_suborders 0、commerce_payments 1、commerce_order_items 2、store_payment_profiles 3（subject_id 全为 NULL）、commerce_customers 1。
- 9 张新表在生产库均不存在 → 无命名冲突。
- `commerce_capture_payment_allocation` 目前只有 1 个重载；v2 是**不同函数名**，不会产生重载歧义。

## 一、阻断项（必须先处理）

**B1. v1 RPC 会在本迁移落地后立即失效，而生产代码仍在调用它。**
`src/routes/api/public/storefront/payments.ts:258` 调用的是 `commerce_capture_payment_allocation`（v1）。本迁移把 `line_amount_fen / order_adjustment_fen / amount_fen` 设为 NOT NULL，v1 的 INSERT 不写这三列 → 下一次真实下单支付会 23502 not-null violation 直接 500。同时 v1 按 profile 拆单，新 `UNIQUE(payment_id, settlement_subject_id)` 会让"同主体多门店"撞 23505。
→ 结论：v1/v2 在**函数层面**可安全并存，但在**数据层面不能并存**。必须二选一：(a) 同批把 payments.ts 切到 v2 再应用迁移；或 (b) 在本迁移内同时 `CREATE OR REPLACE` v1，让它也写 fen 列并按 subject 归并（作为过渡兼容层）。目前 SQL 两者都没做。

**B2. `commerce_payment_suborder_profiles` 只有 v2 会写，v1 不写。**
若 B1 选择保留 v1 过渡，v1 产生的子单在明细表里没有任何行，后续对账/分账按 profiles 关联时会静默丢门店维度。回填语句（第 156–163 行）只覆盖迁移时刻的存量（当前 0 行），不覆盖后续 v1 写入。

**B3. 迁移文件时间戳早于已应用迁移。**
仓库里已有 `20260831190000_handheld_async_listing_images.sql` 与 `20260831213000_hello_kitty_specific_ip.sql`，均晚于 `20260831120000`。插入一个更早时间戳的迁移会让本地文件顺序与实际应用顺序不一致，重建环境（reset/replay）时本文件会在那两个之前执行——本文件不依赖它们，实际可跑通，但顺序假设已破坏。建议改名为一个当前最大时间戳之后的值。

**B4. 迁移不可重跑。**
9 处 `CREATE TABLE`（无 IF NOT EXISTS）、5 处 `CREATE TRIGGER`、6 处 `CREATE INDEX`（部分无 IF NOT EXISTS）、4 处 `ADD CONSTRAINT`（无存在性保护）在任何一次部分失败后重跑都会报 42P07/42710/42710。第 4–32 行反而用了 IF NOT EXISTS，风格不一致。建议全文统一：`ADD CONSTRAINT` 前先 `DROP CONSTRAINT IF EXISTS`，`CREATE TABLE/INDEX` 加 `IF NOT EXISTS`，`CREATE TRIGGER` 前 `DROP TRIGGER IF EXISTS`。

## 二、非阻断建议

1. **触发器 EXECUTE 撤销（第 488–490 行）无实际影响也无害**：Postgres 只在 `CREATE TRIGGER` 时检查函数 EXECUTE 权限，触发时不再检查。保留即可，但别以为它增加了防护。
2. **`validate_marketplace_payment_subject` 未加 SECURITY DEFINER**：触发器以调用者权限执行，函数体只读 NEW，无跨表查询，安全。保持现状即可。
3. **CHECK 的 IMMUTABLE 合规性 OK**：`commerce_payment_suborders_decimal_fen_match` 用的 `round(numeric)` 与 `::bigint` 都是 immutable，不会触发 Postgres 的"CHECK 必须 immutable"报错，也不会影响 restore。
4. **v2 没有校验子单金额之和 = 母支付金额**。这是收付通拆单最容易出错的地方（1 分差）。建议在循环后加 `SELECT sum(amount_fen) ... = (SELECT round(amount*100) FROM commerce_payments WHERE id=p_payment_id)` 的断言。
5. **v2 没有校验运费不计佣**：迁移里 `commerce_settlement_ledger.shipping_amount_fen` 单列已具备条件，但 v2 与 rule 之间没有任何写入衔接（ledger 由谁写未定义）。建议明确 ledger 的唯一写入入口（一个 RPC），否则会出现应用层直写导致快照不可信。
6. **`commerce_reconciliation_items` 的 `UNIQUE (reconciliation_run_id, provider_transaction_id, provider_reference)` 在含 NULL 时不去重**（Postgres 默认 NULLS DISTINCT）。若允许两列为 NULL，同一异常会重复入库。建议 `UNIQUE NULLS NOT DISTINCT` 或给两列设 `''` 默认。
7. **`platform_commission_rules` 缺少"同 scope 时间区间不重叠"的保护**。`UNIQUE(rule_code, version)` 挡不住两条 active 的 platform 默认规则同时生效。建议加 `EXCLUDE USING gist` 或部分唯一索引（scope_type='platform' AND status='active' 且 effective_to IS NULL 时唯一）。
8. **主体扩展缺少个人/小微的身份要素列**：先前设计里的证件类型/号码哈希、同名结算银行卡、银行名称都没进 SQL，而触发器只校验 owner + 协议。`personal_seller` 目前可以在没有任何身份/银行信息的情况下被置为 `provider_application_status='active'`。建议补列并纳入触发器。
9. **"禁止个人 OpenID 收款"没有 schema 级表达**。建议至少在 `payment_subjects` 上加 COMMENT 明示，并确保 provider 层只接受 `wechat_sub_mchid`。
10. **前端校验会挡住个人主体**：`src/lib/store-payments.functions.ts` 的 zod 仍要求 `unified_social_credit_code` 长度 ≥15。数据库放开后，HQ 后台仍无法录入个人/小微主体（本阶段不改 UI 可接受，记为已知缺口）。
11. **`src/lib/payments/store-payment-contract.test.ts` 断言的是旧迁移文本**，本迁移不改那个文件所以测试仍绿；但它无法覆盖新结构，建议为本迁移新增一个契约测试（参考 `src/lib/commerce/schema-contract.test.ts`）。
12. **`commerce_payments.payment_profile_id` 在多主体时被置 NULL（第 473–477 行）**：`src/server/pos-payment.server.ts` 与后台读取处未做 NULL 分支审计，建议在切换 v2 的同批一起检查。
13. `location_ids jsonb` 在 v2 的 `jsonb_to_recordset` 里声明但从未使用，可删，或写进 allocation_snapshot 以免信息丢失。

## 三、事务安全性

全文均为事务性 DDL/DML（无 `CREATE INDEX CONCURRENTLY`、无 `VACUUM`、无 `ALTER SYSTEM`），可在单事务内执行，失败整体回滚。锁方面 `ALTER TABLE payment_subjects / commerce_payment_suborders` 取 ACCESS EXCLUSIVE，当前两表 0 行、无并发交易，锁时间可忽略。历史数据兼容性：两处 UPDATE（第 24–25 行、第 125–128 行）作用于 0 行，`SET NOT NULL` 不会失败；`commerce_payments` 的 1 行、`commerce_order_items` 的 2 行不受本迁移任何约束影响。

## 四、结论

SQL 语法本身无错，约束名与外键目标与生产完全对得上，RLS/REVOKE/GRANT 模式与既有支付表一致且正确（9 张新表全部 ENABLE RLS + 0 policy + service_role only），v2 与 v1 作为两个独立函数名可以共存、无重载歧义、权限收口正确（显式 REVOKE 了 anon/authenticated）。

**唯一真正的阻断是 B1**：迁移一旦落地，仍在被生产代码调用的 v1 会因新的 NOT NULL fen 列和新唯一键而失效。必须与 `payments.ts` 的 v2 切换同批发布，或在本迁移内同时升级 v1 为兼容实现。B3/B4 是工程卫生问题，建议一并修掉再执行。

再次确认：本轮未执行 migration、未写数据库、未发布、未修改任何生产代码。
