# BOOMER GO 店员首页（销售目标 / 补录 / 排班 / Banner / 培训）— 现状核对与最小实施方案

当前 commit：`f23aa5513ae68cfa2fa6015f4a9036d80c0a2dc4`（2026-09-07T14:12:07+08:00）。
本轮仅做只读调查，未改代码、未写数据、未执行迁移、**腾讯生产 erp.boomeroff.com 未部署本轮任何内容**。

## 1. 有赞销售数据：已有什么

有的：
- `youzan_orders`（1948 行，1947 行有 `pay_time`）：字段含 `shop_id`、`kdt_id`、`tid`、`status`、`status_text`、`pay_type`、`payment`、`total_fee`、`post_fee`、`item_count`、`pay_time`、`created_time`、`raw`；唯一键 `(kdt_id, tid)` 用于 upsert 去重。
- 店铺映射：`youzan_shops`（4 家：HQ 1 + 分店 3）→ `inv_locations.shop_id`，4 个库位全部已映射。
- 自动同步：pg_cron 作业 1 `youzan-sync-30min`（每 30 分钟）POST `/api/public/hooks/youzan-sync`，body `{"days":3}`。
- 现成口径参考：`src/lib/youzan-stats.functions.ts`（`getYouzanSummary` / `getShopSalesBreakdown`），按 `pay_time >= 本月1日`、金额取 `payment ?? total_fee` 累加，**未按 status 过滤**。

缺口（必须在本轮补齐才能作为门店目标进度口径）：
- **没有净销售口径**：状态分布 `TRADE_SUCCESS` 1914 / `TRADE_CLOSED` 34，现有汇总把关闭单也算进去；`post_fee`（运费）也未剔除。
- **没有退款数据表**：无有赞退款/售后落库（`commerce_refunds` 行数 0，且属于自营商城域，不是有赞域）；退款只能靠 `status` 粗判，`status ilike '%refund%'` 命中 0 行。
- **数据新鲜度存疑**：`youzan_orders` 最近 `pay_time` = 2026-08-29，最近 `inserted_at` = 2026-08-29；仅中信泰富店有订单，新天地店/温州店 0 单。上线前需确认是真实无成交还是同步中断。
- **没有面向 GO 的销售接口**：`/api/public/handheld/*` 无任何销售额/营业额端点；`dashboard.ts` 只返回库存数、调拨/盘点/拣货任务与未读通知。现有 youzan-stats 是 ERP Web 的 serverFn，GO 无法安全调用。

## 2. 月目标 / 线下补录 / 防重复 / 审计

全部不存在。数据库 `public` schema 中没有任何 `%target%`、`%banner%`、`%train%`、`%quiz%`、`%exam%`、`%schedul%`、`%shift%`（除 `pos_shifts`）命名的表；`app_settings` 只有 3 行全局键值，不适合承载按门店按月的目标。
线下收款侧现有的只有 POS 域：`pos_shifts`（2 行）、`pos_receipts`（1 行）、`pos_payment_attempts`、`pos_cash_movements`——是收银机流水，不是"门店手填补录账本"，且几乎无真实数据。
因此：门店月目标、线下补录、防重复、修改审计**都需要新迁移**。

## 3. 排班 / Banner / 培训测试

ERP 侧无任何表、接口或配置：`pos_shifts` 是收银班次（开/关钱箱、现金差异），语义上不能当排班表用。Banner 与培训测试题库在 ERP 无对应实体。若 GO 原库（客户端本地/旧后端）已有这三块数据，需要 Codex 提供其现有字段与来源，才能决定"ERP 托管配置"还是"GO 自持、ERP 只读透传"。**这是本轮唯一的外部依赖项**。

## 4. 建议的最小实施边界

### 新增表（一份 additive 迁移，可回滚）
- `store_sales_targets(location_id, period_month, target_amount, note, created_by, updated_by, timestamps)`，唯一键 `(location_id, period_month)`。
- `store_offline_sales_entries`：门店手填补录。字段含 `location_id`、`business_date`、`channel`（`cash` / `pos_card` / `wechat_direct` / `alipay_direct` / `other`，**明确排除有赞渠道**）、`amount`、`order_count`、`note`、`client_op_id`（幂等）、`created_by`、`status`（`active` / `voided`）。唯一键 `(location_id, business_date, channel, client_op_id)` 防重复提交。
- `store_offline_sales_audit`：每次新增/修改/作废写一条前后值快照 + 操作人 + 时间。
- 三张表 RLS 开启 + `GRANT` 给 `authenticated` / `service_role`（GO 走设备+session 服务端 admin 客户端读写，Web 侧按角色）。

### 不重复计算的口径（写进代码注释与 OpenAPI）
```text
门店月销售额 = 有赞净销售 + 线下补录净额
有赞净销售 = SUM(payment) WHERE shop→location 命中且 pay_time 在月内
             AND status = 'TRADE_SUCCESS'   (排除 TRADE_CLOSED)
             - SUM(post_fee)                (运费不计业绩)
线下补录净额 = SUM(amount) WHERE status='active' 且 channel ∈ 线下枚举
             (channel 枚举不含 youzan/wechat_youzan，杜绝与有赞重复)
```
有赞侧退款目前无数据源，接口返回 `refund_source: "unavailable"`，不做静默估算。

### 新增 GO 接口（最小契约，全部在 `/api/public/handheld/*`，沿用 `X-Device-Token` + `X-Session-Token`）
- `GET /handheld/store/sales-summary?location_id=&month=` → `{ target_amount, achieved_amount, progress_pct, youzan_amount, offline_amount, order_count, youzan_last_sync_at, refund_source }`
- `GET /handheld/store/offline-sales?location_id=&date_from=&date_to=`（列表 + 分页）
- `POST /handheld/store/offline-sales`（`client_op_id` 幂等；写审计）
- `PATCH /handheld/store/offline-sales/{id}`、`POST .../void`（写审计，不物理删除）
- `GET /handheld/store/home-config?location_id=` → `{ banners[], schedule[], training_tasks[] }`（第一版可只返回 ERP 已托管部分，其余为空数组，等 GO 原库字段确认后填充）

### 权限边界
- 普通店员：严格限定"设备当前绑定库位"，只能读本店目标、读写本店线下补录；不能改目标。
- `store_manager`：本店目标可读、补录可作废。
- `super_admin` / `hq_operator`：可跨店读、可写目标、可查审计；跨店必须显式传 `location_id` 并通过 `userCanAccessLocation` 校验。
- 复用现有 `src/server/handheld-fulfillment-access.server.ts` 的授权范式，避免另起一套。

### 尚缺的前置条件
1. GO 原库中排班 / Banner / 培训测试的现有结构与归属（Codex 提供）。
2. 确认有赞订单同步是否中断（最近成交停在 2026-08-29），否则销售进度会长期偏低。
3. 有赞退款数据源：是否新增退款拉取任务（本轮建议不做，接口先如实标注不可用）。
4. 月目标的录入入口归属：ERP Web 还是 GO 店长端。

需要迁移：**是**（3 张新表 + RLS + GRANT）。本轮不涉及有赞写操作、不涉及腾讯部署。
