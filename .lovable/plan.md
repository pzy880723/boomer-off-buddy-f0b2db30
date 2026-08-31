# Additive Migration 设计审查（只读，未改代码/未写库/未发布）

核对基准：Lovable Cloud 生产 schema 实查 + `supabase/migrations/20260801135327_*.sql`。
现存行数：payment_subjects 0、commerce_payment_suborders 0、commerce_payments 1、commerce_orders 1、commerce_order_items 2、store_payment_profiles 3（3 条 subject_id 均为 NULL）、commerce_customers 1。
8 张拟新增表在生产库均不存在（0 冲突）；`commerce_capture_payment_allocation` 当前只有 1 个重载。

## 1) 与生产 schema 的冲突

| 设计项 | 生产现状 | 冲突 |
|---|---|---|
| subject_type 四值 | `CHECK (subject_type IN ('enterprise','individual_business'))` | 必须先 `DROP CONSTRAINT payment_subjects_subject_type_check` 再重建；纯 ADD COLUMN 不够 |
| 个人主体统一信用代码可 null | `unified_social_credit_code text NOT NULL UNIQUE` | 双重冲突：NOT NULL 要 DROP，UNIQUE 是表约束（`payment_subjects_unified_social_credit_code_key`），需换成 `CREATE UNIQUE INDEX ... WHERE unified_social_credit_code IS NOT NULL` |
| `owner_customer_id` | `commerce_customers` 存在（1 行） | 无冲突；建议 FK `ON DELETE RESTRICT`，避免删除消费者时丢失资金归属 |
| suborders `UNIQUE(payment_id, settlement_subject_id)` | 已有 `UNIQUE (payment_id, payment_profile_id)` | 不冲突但语义打架：旧键会阻止同一主体下多门店合并成一张子单。必须在同一迁移 DROP 旧键 |
| `payment_profile_ids uuid[]` | `payment_profile_id uuid NOT NULL REFERENCES store_payment_profiles(id)` | 旧列 NOT NULL 未放开时，新写入路径若只填数组会直接 NOT NULL 违例 |
| bigint fen 列 | 现有 `line_amount/order_adjustment/amount numeric(12,2)` | 同一事实两套精度并存，需明确唯一真源 |
| 新表 8 张 | 均不存在 | 无冲突 |
| 替换 RPC | 1 个重载，SECURITY DEFINER | 若新签名参数不同会产生**第二个重载**而不是替换，旧调用方仍走旧函数 |
| RLS/权限 | 现有支付表模式是 ENABLE RLS + REVOKE PUBLIC,anon,authenticated + GRANT service_role | 设计一致，无冲突 |

## 2) 会破坏现有数据 / 现有代码的点

数据层面破坏面≈0（关键表 0 行），真正的破坏在**代码契约**：

1. `payment_profile_id` 若立即 DROP 或改可空，`src/routes/api/public/storefront/payments.ts`（第 247 行写入 `payment_profile_id`）与 `src/server/pos-payment.server.ts` 的 `resolveStoreMerchant` 仍按“门店=结算单位”工作，会在支付编排处 500。
2. `src/lib/payments/store-payment-plan.ts` + 其测试断言的是 per-profile 子单结构（`paymentProfileId` 必填、按门店拆单）。改唯一键但不改这层，跨门店同主体订单会在新唯一键上撞 23505。
3. `src/lib/payments/store-payment-contract.test.ts` 断言迁移文件里 `location_id uuid NOT NULL UNIQUE`、`payment_code text NOT NULL UNIQUE` 等文本，新迁移改动这些定义会让契约测试红。
4. `unified_social_credit_code` 从 NOT NULL 放开后，`src/lib/store-payments.functions.ts` 的 zod `min(15)` 仍强制必填，个人卖家路径会被前置校验挡住（本阶段不改 UI 可接受，但要记录为已知缺口）。
5. `ensure_store_payment_profile` 触发器持续为每个 active shop 自动建 profile 且 subject_id 为 NULL（现有 3 条即是）。主体模型下 profile 不再是结算单位，触发器语义需要在注释/文档中降级为“门店收单身份”，否则后续容易被再次误当分账维度。
6. numeric 与 bigint fen 双写：只要没有校验触发器或生成列，两者迟早漂移，且分账/回退按分计算时会出现 1 分差。

## 3) 建议修改

**主体域**
- `subject_type`：DROP 旧 CHECK → 新 CHECK 四值；同时加 `onboarding_mode text NOT NULL DEFAULT 'hq_managed' CHECK (IN ('hq_managed','seller_self_service'))`。
- 统一信用代码：`DROP NOT NULL` + `DROP CONSTRAINT ..._unified_social_credit_code_key` + 部分唯一索引；迁移里先 `NULLIF(btrim(x),'')` 归一防空串。
- 增加**触发器式**完整性校验（不要用 CHECK，涉及跨列与状态时序）：
  - enterprise / individual_business 必须有统一信用代码；
  - micro_merchant / personal_seller 必须有身份要素 + 同名结算银行卡 + 已签协议版本与时间；
  - `provider_application_status='active'` 前置要求 `seller_qualification_status='approved'`；
  - `onboarding_mode='seller_self_service'` 时 `owner_customer_id NOT NULL`。
- 明确禁止个人 OpenID 收款：不建 openid 收款字段，并在 `payment_subjects` 上加 COMMENT 说明；provider 层只接受 sub_mchid。
- `marketplace_seller_subjects` 与 `payment_subjects` 的边界要写清楚：建议它只承载“卖家店铺/招商关系”，主体资金要素仍单一真源在 `payment_subjects`，避免 sub_mchid 出现两处。

**子单与金额**
- 唯一键切换按顺序：ADD 新列 → 回填（当前 0 行）→ `ALTER COLUMN payment_profile_id DROP NOT NULL` → `DROP CONSTRAINT commerce_payment_suborders_payment_id_payment_profile_id_key` → `ADD CONSTRAINT ... UNIQUE (payment_id, settlement_subject_id)`。旧列保留一个版本周期，便于回滚。
- 金额建议**以 bigint fen 为唯一真源**，numeric 列改为生成列或加一致性触发器（`amount = amount_fen/100.0`），不要两边各自写。
- 子单补：`sub_mchid_snapshot text NOT NULL`、`commission_snapshot jsonb`、`platform_fee_fen bigint`、`seller_amount_fen bigint`、`shipping_fee_fen bigint`（佣金不对运费计提，需要单列才能算得清）、`settlement_state`、`settlement_eligible_at`。
- `payment_profile_ids uuid[]`：数组无法建 FK，建议加校验触发器确认每个元素存在且属于同一 subject；或改为 `commerce_payment_suborder_profiles` 明细子表（更利于对账 join 与索引）。索引用 GIN。

**佣金与放行**
- `platform_commission_rules` 用 `rate_bps int` + scope('platform_default','subject','location') + `effective_from/to`，加部分唯一索引防止同 scope 时间重叠；订单支付时整体冻结进快照（policy_id、rate_bps、base_fen、fee_fen）。
- 放行时钟（确认收货 + 7 天观察期）建议落在子单上（`confirmed_at`、`settlement_eligible_at`），`commerce_risk_holds` 只做“阻断原因”表，避免状态双源。

**RPC**
- 不要在旧函数上做 `CREATE OR REPLACE` 改语义，也不要新增不同参数的同名重载（会产生歧义调用）。建议新建 `commerce_capture_payment_allocation_v2(...)`，代码切换后再 `DROP FUNCTION` 旧版。
- v2 校验点：所有 contributing profile 的 `subject_id` 相同且该 subject `erp_verification_status='approved' AND provider_application_status='active' AND wechat_sub_mchid IS NOT NULL`；子单金额之和（fen）严格等于母支付金额；allocation_snapshot 内含 per-location 明细、佣金快照、sub_mchid。
- 权限：`REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC, anon, authenticated`（必须显式列出 anon/authenticated，仅 REVOKE PUBLIC 清不掉显式授权——会员 RPC 已踩过这个坑）+ `GRANT EXECUTE TO service_role`。

**权限模式**：所有新资金表照抄现有支付表模式（ENABLE RLS、0 policy、REVOKE PUBLIC/anon/authenticated、GRANT ALL TO service_role）。第三方卖家自助读取自己主体的 policy 留到有 UI 阶段再加。

## 4) 能否在单事务内安全执行

可以，但建议**拆成多个 migration 文件、每个文件内部是一个事务**：

- 可安全同事务执行：DROP/ADD CHECK、DROP NOT NULL、DROP 表约束 + CREATE UNIQUE INDEX（非 CONCURRENTLY）、ADD COLUMN、CREATE TABLE、CREATE INDEX、GRANT/REVOKE、CREATE FUNCTION。Postgres DDL 全部事务性，失败自动回滚。
- 不能放进事务：`CREATE INDEX CONCURRENTLY`（本轮数据量下不需要）。
- 需要注意的锁：`ALTER TABLE payment_subjects/commerce_payment_suborders` 取 ACCESS EXCLUSIVE 锁；当前 0 行、无并发交易，锁时间可忽略；上线真实交易后再改就必须走双写迁移。
- 建议顺序（各自独立文件，便于逐步回滚）：M1 主体扩展 → M2 佣金规则 → M3 子单结构与唯一键切换 → M4 结算/分账/回退/对账/风控六表 → M5 RPC v2 → M6 权限收口。每步配一个 schema 契约测试（参考 `src/lib/commerce/schema-contract.test.ts` 的写法）在应用前跑通。

**结论**：设计整体与生产 schema 兼容，唯一必须显式处理的三处是 subject_type CHECK、统一信用代码 NOT NULL+UNIQUE、以及子单旧唯一键与 `payment_profile_id NOT NULL`；数据破坏风险≈0（关键表空表），真正风险在代码契约层，schema 与 `payments.ts` / `pos-payment.server.ts` / `store-payment-plan.ts` 必须同批切换。

本轮未编辑任何文件（除本审查文档）、未执行迁移或数据写入、未发布、未触碰有赞与腾讯生产。
