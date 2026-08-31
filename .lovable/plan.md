# 平台收付通交易/分账模型 · 方案审查（只读）

本轮未修改任何代码、未执行迁移、未发布。以下结论基于对 Lovable Cloud 实际 schema 的只读查询与现有迁移 `20260801121530_store_payment_subjects.sql`、`20260801135327_*.sql` 的阅读。

## 现状核验（机器可核对）

行数（当前）：payment_subjects 0、store_payment_profiles 3、commerce_payment_suborders 0、commerce_payments 1、commerce_refunds 0、commerce_orders 1、commerce_order_items 2、commerce_after_sales 0、pos_payment_attempts 0。

关键既有结构：
- `payment_subjects`：`subject_type CHECK IN ('enterprise','individual_business')`；`unified_social_credit_code NOT NULL UNIQUE`；`wechat_sub_mchid UNIQUE`；有 erp_verification_status / provider_application_status 两组状态。
- `store_payment_profiles`：`location_id UNIQUE`、`subject_id` 可空（多门店可指向同一 subject，模型上已支持共享主体）。
- `commerce_payment_suborders`：`UNIQUE (payment_id, payment_profile_id)`，`payment_profile_id NOT NULL`，同时有 `settlement_subject_id NOT NULL`。
- `commerce_order_items`：已有 `settlement_subject_id` + `settlement_snapshot`。
- RPC `commerce_capture_payment_allocation(uuid,uuid,jsonb,jsonb)`（SECURITY DEFINER）写入 item 快照与子单。
- 上述支付类表均已 ENABLE RLS，且 REVOKE anon/authenticated、仅 GRANT service_role。

## A. 与目标模型的差距

1. **主体类型不足**：CHECK 只允许 enterprise / individual_business，缺 micro_merchant、personal_seller。
2. **主体字段偏企业化**：`unified_social_credit_code NOT NULL UNIQUE` 对小微/个人卖家不成立；缺自然人身份要素（证件类型/号码哈希、结算银行卡同名校验、法人 vs 本人）、缺 owner_user_id（自助进件归属）、缺 subject_scope（自营 / 第三方卖家）。
3. **子单分组维度错误**：唯一键是 `(payment_id, payment_profile_id)`，即按门店分组；目标要求按 `settlement_subject_id / sub_mchid` 分组，门店分配只留在快照。共享主体的多门店会被错误拆成多张子单。
4. **无佣金/费率模型**：没有平台佣金默认费率表、门店/卖家覆盖表，也没有订单级不可变费率快照（按分冻结、运费不计提）。
5. **无分账（profit sharing）域**：缺分账单、分账明细（平台服务费 / 卖家应得）、解冻记录、分账回退记录、provider 请求与查询状态。
6. **无资金放行时钟**：订单/子单上没有 confirm_received_at、after_sale_window_ends_at、settlement_eligible_at、hold/freeze 状态，无法表达“确认收货 + 7 天观察期且无售后/风控冻结”。
7. **退款与分账未打通**：`commerce_refunds` 无 suborder_id、无 `pre_share` / `post_share` 分支，无“先分账回退再退款”的编排状态与幂等键。
8. **禁止个人 OpenID 收款** 没有 schema 级约束（当前无字段承载，也无显式禁止注释/校验）。
9. **卖家资格准入缺失**：无资格声明、协议签署版本/时间、平台审核流水（`payment_subject_applications` 只覆盖“向 provider 进件”，不覆盖“平台侧资格审核”）。
10. **provider 骨架缺失**：仅有微信收单方向（pos-payment-provider.server.ts），没有分账/解冻/回退/查询接口抽象。

## B. 推荐的表 / 约束 / 索引 / RLS / RPC

### 主体域（改造现有表）
- `payment_subjects` 扩展：`subject_type` CHECK 加 micro_merchant、personal_seller；`unified_social_credit_code` 改为可空并把 UNIQUE 换成 `WHERE ... IS NOT NULL` 的部分唯一索引；新增 `subject_scope text ('self_operated','third_party')`、`owner_user_id uuid`、`id_doc_type`、`id_doc_number_hash`、`id_doc_last4`、`settlement_bank_account_name`、`settlement_bank_account_last4`、`settlement_bank_name`、`qualification_status`、`agreement_version`、`agreement_signed_at`、`platform_review_status/note/reviewed_by/reviewed_at`、`risk_hold boolean`。
- 触发器式校验（不用 CHECK 跨行）：enterprise/individual_business 必须有统一社会信用代码；micro_merchant/personal_seller 必须有身份要素 + 同名银行卡 + 已签协议；provider_application_status 只有在 platform_review_status='approved' 时才可置 active。
- 新表 `payment_subject_qualifications`（资格声明与协议留痕，一主体多版本）。

### 交易与分组
- `commerce_payment_suborders`：`payment_profile_id` 放开为可空（保留为“主门店”参考），唯一键改为 `UNIQUE (payment_id, settlement_subject_id)`；新增 `sub_mchid_snapshot text NOT NULL`、`commission_snapshot jsonb`、`platform_fee_amount numeric(12,2)`、`seller_amount numeric(12,2)`、`shipping_fee_amount numeric(12,2)`、`settlement_state text ('holding','eligible','sharing','shared','reversed')`、`settlement_eligible_at timestamptz`、`hold_reason text`。
- `allocation_snapshot` 里保留 per-location 明细（immutable）。
- 索引：`(settlement_subject_id, settlement_state)`、`(settlement_state, settlement_eligible_at)`、`(order_id)`。

### 佣金
- `commerce_commission_policies`：scope('platform_default','subject','location')、scope_id、category_code 可空、rate_bps int、min/max、effective_from/to、priority；部分唯一索引防重叠默认。
- 佣金以 **bps + 分（integer cents）** 计算并四舍五入到分，运费单列且不计提；订单支付时整体冻结进 `commission_snapshot`（含 policy_id、rate_bps、base_cents、fee_cents）。

### 分账域（新表）
- `commerce_profit_share_orders`：suborder_id、provider、out_order_no UNIQUE、status(pending/processing/succeeded/failed/reversed)、amount、finished_at、provider_order_id、idempotency_key UNIQUE、last_error。
- `commerce_profit_share_receivers`：分账接收方明细（platform / seller）、类型、金额、描述、结果。
- `commerce_profit_share_unfreeze`：解冻剩余资金记录。
- `commerce_profit_share_reversals`：回退单（退款前置），带 out_return_no UNIQUE + 幂等键。
- `commerce_settlement_events`：所有 provider 回调/查询结果的 append-only 审计（含 signature_verified）。
- `commerce_refunds` 扩展：`suborder_id`、`refund_mode ('pre_share','post_share')`、`reversal_id`、`platform_fee_refund_amount`。

### RLS / 授权
- 所有新表：ENABLE RLS + `REVOKE ALL FROM PUBLIC, anon, authenticated` + `GRANT ALL TO service_role`（与现有支付表一致，0 policy = 仅服务端可达）。
- 第三方卖家自助进件将来需要读自己主体时，再单独加 `owner_user_id = auth.uid()` 的 SELECT policy，并为 authenticated 加最小 GRANT；本阶段不加。
- 新 RPC 一律 SECURITY DEFINER + `REVOKE EXECUTE FROM PUBLIC, anon, authenticated`（沿用会员 RPC 已踩过的坑：默认 REVOKE PUBLIC 不会清掉 anon/authenticated 的显式授权，必须显式 REVOKE 两个角色）。
- RPC 骨架：`commerce_capture_payment_allocation_v2`（按主体分组 + 佣金快照）、`commerce_mark_suborder_settlement_eligible`、`commerce_open_profit_share`、`commerce_reverse_profit_share`，全部幂等键驱动。

## C. 迁移顺序（平滑升级 + 可回滚）

当前 `payment_subjects` 与 `commerce_payment_suborders` 都是 **0 行**，是做结构改造的最佳窗口。

1. **M1 主体扩展（加法）**：放宽 subject_type CHECK、统一社会信用代码改可空 + 部分唯一索引、新增自然人/资格/风控列、建 `payment_subject_qualifications`。回滚：删列/删表、恢复 CHECK 与 UNIQUE（0 行时无损）。
2. **M2 佣金策略表 + 平台默认费率 seed**。回滚：DROP TABLE。
3. **M3 子单分组改造**：新增列 → 回填（本阶段无数据）→ `payment_profile_id` 改可空 → 换唯一键为 `(payment_id, settlement_subject_id)`。回滚：换回旧唯一键、置回 NOT NULL。
4. **M4 分账域四张表 + settlement_events + refunds 扩展列**。回滚：DROP/DROP COLUMN。
5. **M5 RPC v2 与状态机函数**（旧 `commerce_capture_payment_allocation` 保留不动，新逻辑走 v2，代码切换后再择期废弃）。回滚：DROP FUNCTION v2。
6. **M6 权限收口**：所有新对象 REVOKE anon/authenticated、GRANT service_role，并对新 RPC 显式 REVOKE。

每步单独一个 migration 文件、幂等写法（IF NOT EXISTS / DROP CONSTRAINT IF EXISTS），并配套一个 schema 契约测试（比照 `src/lib/pos/pos-workflows-schema-contract.test.ts` 的写法）在应用前本地跑通。

## D. 兼容性与数据风险

1. **子单唯一键变更是最大破坏点**：共享主体的多门店订单在新键下会合并成一张子单，若已有历史行会冲突。现在 0 行，风险≈0；一旦上线真实交易就必须走“新表 + 双写”而不是原地改键。
2. **`payment_profile_id` 由 NOT NULL 改可空**：现有读路径（`src/routes/api/public/storefront/payments.ts` 第 247 行、`src/server/pos-payment.server.ts` 的 `resolveStoreMerchant`）假定它必填，改 schema 而不同步改代码会在支付编排处 500；必须与代码切换同批发布。
3. **`unified_social_credit_code` UNIQUE → 部分唯一索引**：若历史上存在空串而非 NULL，会误判重复；迁移里应先 `NULLIF(trim(x),'')` 归一（当前 0 行，无实际影响）。
4. **`ensure_store_payment_profile` 触发器**会为每个 active shop 自动建 profile 且默认 `subject_id IS NULL`；主体共享模型下 profile 不再是结算单位，需明确 profile 只承载“门店收单身份/展示”，避免继续被当成分账维度。现有 3 行 profile 均需人工挂主体后才可收款。
5. **金额精度**：现有列是 `numeric(12,2)`，而佣金要求“按分冻结”。建议快照里用整数分（cents）字段并与 numeric 列做一致性校验触发器，避免两套精度漂移。
6. **RPC 权限默认值**：新建 SECURITY DEFINER 函数默认对 PUBLIC 可执行，必须显式 REVOKE（此前会员 RPC 已出现过该缺口）。
7. **不引入的东西**：本阶段不建个人卖家自助入口、不动 UI、不接真实微信分账 API、不改有赞相关任何表。

## 技术备注
- 涉及文件：`supabase/migrations/20260801121530_store_payment_subjects.sql`、`20260801135327_*.sql`、`src/routes/api/public/storefront/payments.ts`、`src/server/pos-payment.server.ts`、`src/lib/store-payments.functions.ts`。
- provider 骨架建议放 `src/server/payment-share-provider.server.ts`（纯接口 + 未实现桩），领域计算放 `src/lib/settlement/`（纯函数、可单测：佣金分摊、运费剔除、按分取整、放行时钟）。
