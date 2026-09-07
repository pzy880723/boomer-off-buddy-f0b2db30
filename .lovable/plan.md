# GO 首页与身份/排班范围 —— 只读审计结论 + 最小实施方案

当前代码版本：`e283a421c7ad9be9c9c77912e2cb6c54c0e8fecc`（2026-09-07 10:44 UTC）。
以下全部为只读核查；未改代码、未改角色、未跑迁移、未部署腾讯（预览环境 ≠ erp.boomeroff.com）。

用户已确认的关键约束（本轮纳入，不做其他排班形态）：
- **同一员工同一天只在一家店**，无同日跨店/分段班。GO `shift_schedules` 保留 `UNIQUE(work_date, user_id)`，不新增多班表、不做当天切店、不做分段迁移。
- 员工有效门店 = 按 Asia/Shanghai 当日唯一排班解析出的单店；跨店只发生在不同日期。
- 无排班 / 休息（off）/ 排班读取失败 三种状态分开返回，任何情况下不得回退固定 `staff_profile.shop_id` 伪装成今日工作店。

## 一、现状证据（只读 SQL / 文件）

角色与门店
- `user_roles`：只有 `super_admin` 4 人，没有 `hq_operator` / `store_manager` / `store_staff` 任何一行。
- `user_location_perms`：0 行。目前"门店范围"在 ERP 里没有数据，所有人都是全局总部。
- `inv_locations`（active）：中信泰富店、新天地店、温州朔门古港店（3 家均已映射有赞 `shop_id`）+ 总部仓库。
- 结论：与你说的"总部账号没有门店"一致，但反向"门店账号"也一个都还没建。

GO 身份桥接
- `go_identity_links` 已建（`go_project_ref, go_user_id, go_phone_hash, erp_user_id, location_id, erp_role, status, approved_by/at, revoked_at`），**0 行**。
- 只有表，没有接入代码：仓库里没有任何读写它的服务端逻辑，也没有 GO JWT 校验端点。
- 可复用的验签实现已存在：`src/server/consumer-auth.server.ts`（RS256 + JWKS + issuer/audience，含缓存），测试在 `src/server/consumer-auth.test.ts`；目前只服务消费者端身份服务。
- 现有 handheld 全部接口走 `X-Device-Token`(+可选 `X-Session-Token`)（`src/server/handheld-auth.server.ts`）；GO 的 Supabase JWT 现在**无法**调用任何 handheld 接口。

排班 / 员工资料
- ERP 库里 `shift_schedules`、`staff_profiles`、`shop_kb_entries`、`notifications` 均不存在（只读核查为 NULL）。排班权威源在 GO 原库，ERP 侧零数据、零结构。
- `go_identity_links.location_id` 是单个 location；按你的新约束（当日单店），员工身份映射仍保留一个"常驻/默认门店"字段只是可选信息，**当日有效门店一律由 GO 当日唯一排班决定**，不用它兜底。

有赞同步与金额口径
- `youzan_orders`：1948 单，`max(pay_time) = 2026-08-29 08:27:38+00`；30 天内仅 08-26~08-29 有数据 → **自 8/29 起再无新订单入库**。
- 近 24 小时同步日志：`orders` error 83 次、`items` error 162 次，错误文本统一为「上次同步进程中断或超时（自动重置）—— 可能是 Worker 单次请求超时，请改用后台同步」；另有 `running` 残留（orders 2、items 4）。定时任务在跑，但每次都超时自重置。
- `commerce_refunds` = 0；`youzan_orders` 无退款金额列（有 `payment,total_fee,post_fee,pay_time,status,status_text`）。**没有任何退款源**。
- 金额口径只能是 `payment ?? total_fee` 减 `post_fee` 的"已付毛额"，且必须携带 `incomplete` 标记（同步滞后 + 退款源缺失），不能对 GO 显示"净销售"，更不能静默显示 0。

手持日汇总现状
- `src/routes/api/public/handheld/store.daily-summary.ts`：设备令牌必需；默认设备绑定 location；传不同的 `location_id` 需 session 且 `userCanAccessLocation` 通过。**只支持单店，没有 HQ 全店总览**，也没有"按当日排班判定门店"。
- `src/server/store-targets.server.ts` 的 `loadDailySummary({locationId, date})` 同样单店。

## 二、待确认的设计（确认后再实施；视觉稿另定）

1) 角色与范围
- `user_roles` 表示身份（`super_admin/hq_operator/store_manager/store_staff`），`user_location_perms` 表示可访问门店集合；总部角色不写 location 行，即"总部无门店"。
- 派生 `scope`：`hq`（全部门店）/ `store`（固定单店）/ `scheduled`（跨店员工，门店由 GO 当日唯一排班决定）。

2) 排班权威源（按你确认的约束定稿）
- 权威留在 GO，ERP **不建** `shift_schedules`、不迁移、不清空；GO 侧保留 `UNIQUE(work_date, user_id)`。
- ERP 只接受"当日在岗门店"的**单值**输入，并由 ERP 向 GO 校验，不信任客户端传参：GO 服务端签发的 JWT 带 `shift_location`（当日 GO shop 标识，单值），或 ERP 反调 GO 只读端点换取。二选一，需你确认。
- 解析结果只有三种，且互斥：`{ state:'scheduled', location }` / `{ state:'off' }` / `{ state:'unavailable' }`；任何情况下都**不**回退 `staff_profile.shop_id`。

3) `go_identity_links` 补丁迁移（新增，不改旧迁移）
- 增加 `erp_scope`（`hq`/`store`/`scheduled`）与 `default_location_id`（仅 store 时用）；增加 `(go_project_ref, go_user_id)` 唯一约束与 approved 生效的读取路径。
- 注意：这是迁移动作，必须等本方案确认后才提交。

4) 接口契约（脱敏，全部只读）
- `POST /api/public/go/session`：入参 GO JWT（Bearer）。JWKS 验签 + issuer/audience，查 `go_identity_links` 且 `status='approved'`，返回 `{ scope, home_location?, shift:{ state:'scheduled'|'off'|'unavailable', location? } }`。未登记或 pending → 403 `identity_not_linked`，绝不降级 anon。
- `GET /api/public/go/store/daily-summary?date=&location_id=`
  - `scope=hq`：不传 `location_id` → `{ scope:'all', totals:{...}, by_location:[{location_id,name,target_fen,actual_fen,diff_fen,completeness}] }`；传 → 单店。
  - `scope=store|scheduled`：只允许 `shift.state='scheduled'` 的那一家店；越权或 off/unavailable → 403/409。
  - 每店与总计都带 `completeness:{ sales_synced_through, refund_source:'unavailable', incomplete, reasons:[...] }`。
- `GET /api/public/go/shifts/today`：HQ 返回全部门店当日排班；员工只返回本人当日那一条（或 off/unavailable）。数据从 GO 权威源读，ERP 不落库。
- handheld `store/daily-summary` 保持单店语义不变，**另加** `scope=all`（仅 HQ 角色可用，非 HQ 直接 403），不放宽任何员工权限。

5) 有赞同步修复（最小方案）
- orders/items 从"单次请求跑完"改后台分页任务：每次 cron 只推进有限页并把游标写回 `youzan_shops`，避免 Worker 超时；`running` 残留改为按 lease 超时判定。
- 同步恢复前，GO 首页显示"数据截至 2026-08-29 + 同步异常"，不显示 0。

## 三、待部署 / 未解决项
- 腾讯生产 `erp.boomeroff.com` 未部署本轮任何内容；预览 ≠ 线上。
- GO JWT 的 issuer/audience/JWKS URL，以及 GO 是否愿意在 token 内下发当日 `shift_location` —— 需你确认。
- 退款源仍缺失，任何"净销售"口径都无法交付。
- ERP 目前没有门店级账号；需先建 `hq_operator/store_manager/store_staff` 角色行与 `user_location_perms`（作为独立步骤，本轮未做）。
- 视觉稿待确认后再发实施任务，由你直接下达。
