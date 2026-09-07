# GO 首页与身份/排班范围 —— 只读审计结论 + 最小实施方案

当前代码版本：`e283a421c7ad9be9c9c77912e2cb6c54c0e8fecc`（2026-09-07 10:44 UTC）。
以下全部为只读核查；未改代码、未改角色、未跑迁移、未部署腾讯（预览环境 ≠ erp.boomeroff.com）。

## 一、现状证据（只读 SQL / 文件）

角色与门店
- `user_roles`：只有 `super_admin` 4 人，没有 `hq_operator` / `store_manager` / `store_staff` 任何一行。
- `user_location_perms`：0 行。也就是说目前"门店范围"在 ERP 里完全没有数据，所有人都是全局总部。
- `inv_locations`（active）：中信泰富店、新天地店、温州朔门古港店（3 家均已映射有赞 `shop_id`）+ 总部仓库。
- 结论：用户说的"总部账号没有门店"与库里一致，但反过来"门店账号"也一个都还没建。

GO 身份桥接
- `go_identity_links` 已建（`go_project_ref, go_user_id, go_phone_hash, erp_user_id, location_id, erp_role, status, approved_by/at, revoked_at`），**0 行**，默认 pending。
- 只有表，没有接入代码：仓库里没有任何读写 `go_identity_links` 的服务端逻辑，也没有 GO JWT 校验端点。
- 可复用的验签实现已存在：`src/server/consumer-auth.server.ts`（RS256 + JWKS + issuer/audience 校验，含缓存），`src/server/consumer-auth.test.ts` 有测试。这是接 GO JWT 最省事的模板，但目前它只服务消费者端身份服务。
- 现有 handheld 全部接口走 `X-Device-Token`(+可选 `X-Session-Token`)，见 `src/server/handheld-auth.server.ts`；GO 的 Supabase JWT 现在**无法**调用任何 handheld 接口。

排班 / 员工资料
- ERP 库里 `shift_schedules`、`staff_profiles`、`shop_kb_entries`、`notifications` 均为 `NULL`（不存在）。排班权威源在 GO 原库，ERP 侧零数据、零结构。
- `go_identity_links.location_id` 是**单个** location，无法表达"跨店员工按当日排班换店"，这是本轮设计要改的点。

有赞同步与金额口径
- `youzan_orders`：1948 单，`max(pay_time) = 2026-08-29 08:27:38+00`，30 天内仅 08-26~08-29 有数据 → **自 8/29 起再无新订单入库**。
- 近 24 小时同步日志：`orders` error 83 次、`items` error 162 次，错误文本统一为「上次同步进程中断或超时（自动重置）—— 可能是 Worker 单次请求超时，请改用后台同步」；另有 `running` 残留行（orders 2、items 4）。定时任务在跑，但每次都超时自重置。
- `commerce_refunds` = 0；`youzan_orders` 无退款金额列（有 `payment,total_fee,post_fee,pay_time,status,status_text`）。**没有任何退款源**。
- 因此金额口径只能是：`payment ?? total_fee` 减 `post_fee` 的"已付毛额"，且必须携带 `incomplete` 标记（同步滞后 + 退款源缺失），不能对 GO 显示为"净销售"，更不能静默显示 0。

手持日汇总现状
- `src/routes/api/public/handheld/store.daily-summary.ts`：设备令牌必需；默认取设备绑定 location；传 `location_id` 且与设备不同则要求 session 且 `userCanAccessLocation` 通过。**只支持单店，没有 HQ 全店总览**，且没有"按当日排班判定门店"的概念。
- `src/server/store-targets.server.ts` 的 `loadDailySummary({locationId, date})` 也是单店。

## 二、待确认的设计（确认后再实施）

1) 角色与范围
- 用 `user_roles`（`super_admin/hq_operator/store_manager/store_staff`）表示身份，用 `user_location_perms` 表示"可访问门店集合"；总部角色不写任何 location 行，即"总部无门店"。
- 新增只读派生概念 `scope`：`all`（HQ）/ `store`（单店）/ `scheduled`（跨店员工，按当日排班解析）。

2) 排班权威源
- 排班权威留在 GO，ERP **不建** `shift_schedules`、不迁移、不清空。
- ERP 只接受一个"当日在岗门店集合"的输入，并且必须由 ERP 自己向 GO 校验，不信任客户端传参：由 GO 服务端签发的 JWT 里带 `shift_locations`（当日班次门店的 GO shop 标识数组），或 ERP 反向调用 GO 一个只读端点换取。二者选一，需要你确认哪种更好落地。
- 数据结构支持"一天多班/多店"：解析结果是数组，不是单值。

3) `go_identity_links` 需要的调整（新增补丁迁移，不改旧迁移）
- `location_id` 单值 → 增加 `erp_scope`（`hq`/`store`/`scheduled`）与 `default_location_id`；跨店员工不预置固定门店。
- 增加 `(go_project_ref, go_user_id)` 唯一约束与 `approved` 才生效的读取路径。

4) 接口契约（脱敏，全部只读）
- `POST /api/public/go/session`：入参 GO JWT（Authorization: Bearer）。ERP 用 JWKS 验签 + issuer/audience 校验，查 `go_identity_links` 且 `status='approved'`，返回 `{ scope, locations:[{id,name}], today_shift_locations:[...] }`。未登记或 pending → 403 `identity_not_linked`，绝不降级为 anon。
- `GET /api/public/go/store/daily-summary?date=&location_id=`
  - `scope=hq`：不传 `location_id` → 返回 `{ scope:'all', totals:{...}, by_location:[{location_id,name,target_fen,actual_fen,diff_fen,completeness}] }`；传 → 单店。
  - `scope=store|scheduled`：忽略客户端传入的越权 `location_id`，只允许当日排班解析出的门店集合；越权返回 403。
  - 每个门店与总计都带 `completeness:{ sales_synced_through, refund_source:'unavailable', incomplete:true/false, reasons:[...] }`。
- `GET /api/public/go/shifts/today`：HQ 返回全部门店当日排班；员工只返回本人。数据从 GO 权威源读，ERP 不落库。
- handheld 侧 `store/daily-summary` 保持单店语义不变，**另加** `scope=all`（仅 HQ 角色可用，非 HQ 请求该参数直接 403），不放宽任何员工权限。

5) 有赞同步修复（最小方案）
- 把 orders/items 同步从"单次请求跑完"改成后台分页任务：每次 cron 只推进有限页、把游标写回 `youzan_shops`，避免 Worker 超时；并清理 `running` 残留行的自重置逻辑，改为按 lease 超时判定。
- 在同步真正恢复前，GO 首页必须显示"数据截至 2026-08-29 + 同步异常"，不显示 0。

## 三、待部署 / 未解决项
- 腾讯生产 `erp.boomeroff.com` 未部署本轮任何内容；预览不等于线上。
- GO JWT 的 issuer/audience/JWKS URL 与 GO 侧是否愿意在 token 内下发当日班次门店 —— 需要你确认。
- 退款源仍缺失，任何"净销售"口径都无法交付。
- ERP 目前无门店级账号，需要先建 `hq_operator/store_manager/store_staff` 角色行与 `user_location_perms`（本轮未做，等你确认后作为独立步骤）。
