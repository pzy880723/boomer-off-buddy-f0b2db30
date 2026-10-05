# BOOMER GO 登录慢 / 业绩读不到：只读诊断结论与修复方案

本轮只读，未改代码、迁移、生产记录，也未部署。当前看到的 commit：`ceeb7e40`（fix(support): avoid duplicate OpenAPI conflict response key）。

## 1. 诊断结论（Lovable Cloud 内嵌库，已实查）

- 数据库健康：在线，内存 65%，磁盘 46%，连接 20/60，48 小时内没有资源耗尽告警。慢不是数据库容量问题。
- **门店映射为空：`go_shop_location_links` = 0 行**。店员当天排班的 GO 门店映射不到 ERP 门店，所以 `todayLocationId` 为空，daily-summary 拿不到门店，业绩一直读不到。这是业绩读不到最可能的直接原因（还需在腾讯日志里按错误码确认）。
- `go_identity_links` = 0 行：代码会退回使用 GO 可信映射（`erp_link_from_go_trusted_mapping`），不会因此直接失败，但 ERP 这边也没有可审计的绑定。
- 日目标：最近 7 天 `store_daily_targets` 只有 3 条，有 4 家有赞店铺，多数门店多数日子没有目标。
- 有赞订单：共 2580 单，7 天内更新 331 单，最新更新时间 10-05 13:58 UTC。同步游标 124 个：done 56、pending 11、**failed 57**（最新一次失败在 09-28，报错为“库存扣减 62 未匹配”）。说明订单拉取在跑，但有一批历史日期窗口失败、没有重试成功。同步接口返回 200 不等于覆盖完整。
- 退款：GO 日汇总固定返回 `has_refund_source:false`，有赞没有退款数据源，只能按 paid_gross 加 incomplete 标记。

## 2. 登录慢的瓶颈（代码证据）

`authenticateGoActor`（session 和 daily-summary 都会调用）完全串行执行：
1. 远程调用 GO `auth.getUser`
2. 远程调用 GO scope RPC
3. 然后在 ERP 依次查 identity_links → admin.getUserById → user_roles → scope_sync_outbox → 门店列表 → 门店权限 → shop_links

两次远程 GO 调用各自受 `GO_FETCH_TIMEOUT_MS = 8_000` 限制，最坏约 16 秒，再加上 7 次串行的 ERP 查询。9 月 14 日的结论（GO 端 scope pull 预算 8 秒，而 ERP 内部串行两次 8 秒核验）**在代码层面仍成立**。daily-summary 还会把整套核验再跑一遍。

## 3. 无法实查的部分（腾讯线上）

- 腾讯 `.env` 里是否有 YOUZAN_CLIENT_ID/SECRET、GO 桥接环境变量（app_settings 为空不能证明部署环境里没有）。
- 腾讯 systemd 订单同步 timer 是否在运行、运行日志、出口代理/白名单状态。
- erp.boomeroff.com 上 /api/public/go/* 的真实耗时和错误码分布。
- GO 项目端 scope RPC 本身的耗时。

## 4. 可复用的 ERP 配置（KPI / 培训 / 规则）

- 已有：`store_daily_targets`、`store_monthly_target_plans`、`store_target_audit_logs`（目标，RLS 为 HQ 写、门店读）；`official_knowledge_entries/relations`（知识库，`/knowledge` 页面）；`app_settings`（全局规则键值，限 super_admin）。
- 没有：员工个人 KPI 表、培训题库/考试表。代码里只有 `/knowledge` 和 mock 数据提到相关内容。新增的管理配置只能放在 ERP 里。

## 5. 修复建议（不需要密钥，待你批准后实施）

1. 在 ERP 后台补门店映射：增加 HQ 维护 `go_shop_location_links` 的入口（或一次性迁移，写入 4 家店的 GO 门店 ID 对应关系，ID 由你提供），并在 session 响应里明确返回 `shop_unmapped` 错误码，不再静默返回“无门店”。
2. 压缩认证链路：两次 GO 远程调用改为并行；ERP 侧 6 次查询用 Promise.all 并发；给单次核验加整体预算（例如 6 秒）；对同一 token 的核验结果做 30–60 秒短缓存，避免 session 和 daily-summary 重复核验。
3. 同步覆盖：给 failed 游标加只读的“覆盖报告”接口（按日、按店铺统计 done/failed/pending），daily-summary 遇到对应日期窗口 failed 时返回 `incomplete` 和原因，不按 0 计算。
4. 日目标缺失时返回 `target_missing`，不能显示成 0。
5. 员工 KPI / 培训题库：先只出 ERP 表结构方案，HQ 写、门店只读，GO 只读拉取；确认后再建表。

## 6. 真实验收路径

1. 腾讯：`curl -w '%{time_total}'` 测 /api/public/go/session 和 daily-summary（店员 token 和 HQ token 各测一次），记录耗时和 `code`。
2. 映射补齐后，店员当天排班门店的 session 必须返回非空 `today_location_id`。
3. daily-summary 的金额与有赞后台同一天、同一门店的支付金额核对；incomplete/refund 标记要如实显示。
4. 腾讯同步日志里 failed 游标数要下降，并且有一次真实 code=200 的入库计数，光看接口返回 200 不算。

## Technical details

- 证据 SQL：游标按 status 统计结果为 failed 57 / pending 11 / done 56；go_identity_links 0；go_shop_location_links 0；youzan_shops 4。
- 关键代码：`src/server/go-bridge.server.ts:131-240`，`src/server/trusted-go-fetch.server.ts:4`。
