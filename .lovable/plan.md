# 状态更新（2026-09-07 16:40 UTC）

- **仪表盘后端/API 与迁移**：已由 Codex 在 `main@22550c0` 合并并继续开发；数据库 RPC 已存在，UI 完整实现位于 `codex/sales-dashboard-v1@7396e9e`，正在腾讯云候选验证。
- **Lovable 侧此前新增的销售仪表盘代码保留**，但新页面将调用 `operational-dashboard.functions/server`；Lovable 不再修改仪表盘页面、路由或执行任何迁移。
- **此前两个开发请求已 superseded**：不再继续销售仪表盘后端实现与 GO 排班/身份方案的实施；发布由 Codex 负责。
- 本文件其余部分保留为上一轮已完成的 ERP 全模块只读审计记录，结论仍然有效。

---

# ERP 全模块只读审计（Lovable 侧证据补充）


本轮**严格只读**：未编辑代码、未执行 migration、未修改数据、未 Publish。**腾讯生产 erp.boomeroff.com 完全未改动**，本报告全部基于 Lovable 内嵌数据库与当前仓库。
分级：`[缺陷]` = 已确认；`[风险]` = 推断需复核；`[建议]` = 产品层面。

## 1. 当前版本
- commit `618f776724d7912a443c511456b1d1818b81bc83`（2026-09-07 10:57 UTC）。
- 上一轮审计基线为 `e283a421…`，其后仅有本项目内的目标/汇总相关自动提交。

## 2. 迁移一致性
- 仓库 `supabase/migrations/` 末尾 5 个：`20260906205250…`、`20260906205457…`、`20260906205748_fulfillment_complete_pick_safety.sql`、`20260907102650…`、`20260907104254…`。
- **无法直接核对已应用版本表**：`select … from supabase_migrations.schema_migrations` 返回 `ERROR: permission denied for schema supabase_migrations`（只读角色权限受限）。`[风险]` 仓库与库的迁移一致性本轮**未能证明**，只能间接从对象存在性推断（上一轮已确认 09-07 两份目标相关迁移的对象都在库里）。要精确核对需用后台迁移工具而非只读连接。

## 3. 安全面（仅元数据，未读取任何密钥或客户资料）
- `public` 表 **123 张**，**RLS 关闭 0 张**。
- `[缺陷] RLS 已启用但零策略：53 张`，等于对 Data API 完全锁死（服务端 service_role 仍可用）。清单包含整条商城/支付/POS/履约链：`commerce_orders/order_items/payments/payment_suborders/payment_events/refunds/after_sales/listings/customers/customer_identities/membership_*/points_ledger/consumption_records/recognition_usage_*/coupon_definitions/member_code_sessions`、`fulfillments/fulfillment_items/fulfillment_scans/fulfillment_exceptions`、`pos_*`（14 张）、`shipments/shipment_events/packages/package_evidence/warehouse_totes`、`inventory_reservations(_lines)`、`payment_subjects/payment_subject_applications/store_payment_profiles`、`inv_listing_image_jobs`、`youzan_category_group_links/sync_runs`、`aigc_sso_tickets`、`editorial_content_user_actions`、`print_events`。
  - 影响：这些模块**只能走服务端 service_role**，任何"前端直连读写"的实现都会静默失败；同时也说明这些域尚未做过面向角色的权限设计。
- `[风险] 宽泛 `USING (true)` 的写策略 40 条`，覆盖 `inv_skus / inv_stocks / inv_stock_movements / inv_epcs / inv_locations / inv_inbound_* / inv_label_batches / stocktakes / stocktake_lines / stocktake_scans / stock_transfer_lines / stock_transfer_epcs / japan_parcels(_items) / domestic_orders / domestic_bulk_* / sku_youzan_links / youzan_stock_sync_queue / app_settings / org_addresses`。
  - 缓解事实：`pg_policy.polroles` 中**没有任何一条包含 `anon`**，且 `information_schema.role_table_grants` 显示 `anon` 与 `authenticated` 在 public 下的 INSERT/UPDATE/DELETE 授权数为 **0 行**。所以不是"匿名可写"，而是"**任何已登录 ERP 用户在库层面不受门店/角色约束**"，实际约束目前只存在于应用层。
- SECURITY DEFINER 函数共 **47 个**；其中 `anon` 仍可 EXECUTE 的 6 个：`inv_apply_movement`、`sync_handheld_custom_listing`，以及 4 个触发器函数（`tg_editorial_content_action_count`、`tg_editorial_content_comment_count`、`tg_editorial_content_engagement_init`、`tg_fulfillment_enqueue_pick_ticket`）。
  - `[缺陷]` `inv_apply_movement` 对 anon 可执行 = **匿名可直接改库存**（触发器函数被直接调用一般会失败，风险低；这两个不是）。这是本轮最高优先级的单点。

## 4. 模块清单与实现程度（不以"有页面"判定闭环）
- **纯示例数据、无后端**（`[缺陷]` 明确未实现）：`src/routes/purchase.japan-bulk.tsx`、`src/routes/shop-mgmt.franchisees.tsx`、`src/routes/knowledge.tsx`、`src/routes/inventory.batches.tsx` —— 四者均 `import … from "@/lib/mock-data"`，按钮多为 `toast.info("功能开发中")`（japan-bulk 3 处）。即：日本大宗采购、加盟商/开店、运营知识库、批次管理**没有业务闭环**。
- **有后端但库内近乎无数据**（`[风险]` 未经真实业务验证）：`commerce_orders=1`、`commerce_payments=1`、`fulfillments=0`、`stock_transfers=0`、`stocktakes=1`、`pos_shifts=2`、`support_conversations=0`、`editorial_contents=2`。网店订单分店履约、客服协作、调拨、POS 会员优惠、支付分账退款对账全部处于"代码在、真实流水近乎为零"的状态。
- **支付分账/对账**：`payment_subjects/applications/store_payment_profiles` 存在但零策略；`commerce_refunds` **0 行**，`youzan_orders` 无退款金额列 → `[缺陷]` **退款与对账口径在数据层就不成立**，任何"净销售/已对账"表述都不可交付。
- **有赞队列**：`youzan_stock_sync_queue` done 904 / failed 4；`channel_sync_outbox` succeeded 2；`inv_listing_image_jobs` succeeded 5；`print_jobs` 0 行。
- **有赞订单同步**：`[缺陷]` `max(pay_time)=2026-08-29`，近 24h `orders` error 83 / `items` error 162，错误恒为「上次同步进程中断或超时（自动重置）—— 可能是 Worker 单次请求超时，请改用后台同步」。自 8/29 起无新订单入库。
- **系统权限**：`[缺陷]` `user_roles` 只有 `super_admin` 4 行，`user_location_perms` **0 行** —— 四级角色模型（hq_operator/store_manager/store_staff）**在数据层从未启用**，`/admin/users` 页面存在不等于权限体系生效。
- **商品标准/自定义/组包、库存调拨盘点、采购（日本小包/国内小包/国内大宗）、POS 基础收银**：有真实表与真实数据，属已落地部分。

## 5. 一致性抽查（仅数量）
- `sku_youzan_links` 孤立映射（指向不存在 SKU）：**0**。
- `inv_stocks.qty < 0`：**0**。
- 失败队列合计：有赞库存 4 条 failed；其余队列无 failed。
- `[风险]` 未抽查：`fulfillment_items` 与 `commerce_order_items` 数量对齐、`inv_epcs` 与 `inv_stocks` 交叉一致性（样本量太小，结论无意义）。

## 6. 测试与权限覆盖缺口
- 测试文件 36 个、含 `test(` 的文件 130 个，集中在 handheld（fulfillment/orders/products/print/smart-create）、识别、目标分配、consumer-auth。
- `[缺陷]` 覆盖缺口：**没有任何 RLS/策略级的负向权限测试**（无"店员不能读他店数据"的库层断言）；POS 支付、分账、退款对账、有赞同步 worker、ERP Web 路由均无自动化测试。
- `[缺陷]` 权限缺口：应用层已有 `userCanAccessLocation` 等判断，但库层 40 条 `true` 策略使其成为**唯一防线**；一旦有任何路径直接用用户 JWT 访问表，门店隔离即失效。

## 7. 建议的重构优先级（`[建议]`，待你确认后再谈实施）
1. 收回 `anon` 对 `inv_apply_movement` / `sync_handheld_custom_listing` 的 EXECUTE。
2. 落地角色数据：建 `hq_operator/store_manager/store_staff` 行 + `user_location_perms`，否则任何门店范围功能（含 GO 首页）都无处落脚。
3. 把 40 条 `true` 策略逐域改写为 `has_role() OR location ∈ user_location_perms`，并补库层负向测试。
4. 修有赞同步（改后台分页 + lease 超时），在恢复前所有汇总必须显式 `incomplete`。
5. 对四个 mock 页面明确取舍：要么排期实现，要么在导航中标注未开放，避免被当作已有能力。

---

## 附：上一轮 GO 排班/身份方案（等你确认，尚未实施）
- 已确认约束：同一员工同一天只在一家店；GO `shift_schedules` 保留 `UNIQUE(work_date,user_id)`；不建多班表、不做当天切店/分段迁移；员工当日门店按 Asia/Shanghai 唯一排班解析；无排班 / 休息 / 读取失败三态分开，**不回退 `staff_profile.shop_id`**；总部显式 HQ、可看全部门店，ERP 统一配置。
- 待确认项：GO JWT 的 issuer/audience/JWKS URL；当日门店由 token 下发还是 ERP 反调 GO 只读端点；`go_identity_links` 增补 `erp_scope`/唯一约束的补丁迁移；handheld `daily-summary` 增 `scope=all`（仅 HQ）。
- 视觉稿与实施任务由你直接下达。
