# 腾讯全量迁移 · 剩余依赖只读审计

只读执行。未改代码、数据库、调度器或生产配置；未触发有赞/支付/短信/AI 业务调用。以下均为当前源码与嵌入数据库的实测事实。

## 1. 当前 Git SHA

`5f3284ac6101cbb3da4557080cf04c93ab3a4faa`，工作区干净（`git status --porcelain` 无输出）。

## 2. cron job 实测状态（仅 host+path，未输出 headers/token）

| jobid | name | schedule | active | host | path | 最近一次入队 | 状态 |
|---|---|---|---|---|---|---|---|
| 1 | youzan-sync-30min | `*/30 * * * *` | false | `project--2158bffa-…lovable.app` | `/api/public/hooks/youzan-sync` | 2026-09-07 19:00Z | succeeded（已停用） |
| 2 | youzan-stock-worker-tick | `* * * * *` | true | `project--2158bffa-…lovable.app` | `/api/public/hooks/youzan-stock-worker` | 2026-09-10 06:57Z | succeeded |
| 3 | channel-sync-worker-tick | `* * * * *` | true | `project--2158bffa-…lovable.app` | `/api/public/hooks/channel-sync-worker` | 2026-09-10 06:57Z | succeeded |
| 4 | commerce-release-expired-every-minute | `* * * * *` | true | `project--2158bffa-…lovable.app` | `/api/public/hooks/commerce-release-expired` | 2026-09-10 06:57Z | succeeded |
| 5 | listing-image-worker-every-minute | `* * * * *` | true | `erp.boomeroff.com` | `/api/public/hooks/listing-image-worker` | 2026-09-10 06:57Z | succeeded |

注意：`cron.job_run_details.status = succeeded` 只表示 `net.http_post` 成功入队，**不代表 HTTP 成功**。实际 HTTP 结果在 `net._http_response`（滚动窗口 1,440 条）：**200 共 1,080 条，401 共 360 条**，恰好等于 4 个活跃 job 中 1 个持续失败的比例。对应的是 `channel-sync-worker-tick`：cron 命令未发送鉴权头，而路由 `src/routes/api/public/hooks/channel-sync-worker.ts:55-64` 要求请求头 `apikey` 匹配 `SUPABASE_PUBLISHABLE_KEY`（回退 `SUPABASE_ANON_KEY`），缺失即 401。该任务实际上长期未生效，只报告不修改。

`commerce-release-expired`（`src/routes/api/public/hooks/commerce-release-expired.ts`）无任何鉴权，是唯一可匿名触发的写入型 hook。

## 3. Edge Functions 与 Realtime

- **Edge Functions：仓库内为零**。`supabase/` 下只有 `config.toml`、`migrations`、`tests`，无 `functions` 目录；`config.toml` 仅一行 `project_id`，无函数配置块。平台侧是否残留历史部署函数需 Codex 在控制台核实，本轮无法从代码侧证明。
- **Realtime 订阅：源码中零调用**。`rg "\.channel\(|removeChannel|realtime" src` 无匹配。客服等实时性需求走请求/轮询，不依赖 Realtime 服务。

## 4. 队列 / worker / 租约 与触发入口归属

| 队列或 worker | 触发入口 | 执行方 | 当前数据状态 |
|---|---|---|---|
| 有赞库存同步队列 `youzan_stock_sync_queue` | cron#2 → `youzan-stock-worker.ts` → `runStockSyncWorkerForCron`（`src/lib/youzan-sync.functions.ts`） | **Lovable 托管域** | done 904、failed 5 |
| 渠道同步 outbox `channel_sync_outbox` + `claim_channel_sync_tasks` 租约 | cron#3 → `channel-sync-worker.ts` | **Lovable 托管域，且因 401 实际未执行** | succeeded 2 |
| 预留过期释放 `commerce_release_expired_reservations` | cron#4 → `commerce-release-expired.ts` | **Lovable 托管域** | 无独立队列表 |
| 上架图任务 `inv_listing_image_jobs` | cron#5 → `listing-image-worker.ts` → `runListingImageWorker`（`src/server/handheld-listing-image-jobs.server.ts`） | **腾讯 `erp.boomeroff.com`** | succeeded 5 |
| 有赞订单同步游标 `youzan_order_sync_cursors`（含租约 `youzan_claim_order_sync_cursor`） | cron#1（已停用）→ `youzan-sync.ts`；备用 `infra/tencent/boomer-youzan-sync.timer` + `scripts/run-youzan-sync.mjs` | 当前**无人执行**；腾讯 unit 文件头部注明「Template only」，未启用 | done 8、failed 16 |
| 普通支付对账 | `infra/tencent/boomer-ordinary-reconcile.timer` → `scripts/reconcile-ordinary-payments.mjs` | 腾讯服务器（模板已就绪） | — |
| 数据平台备份/健康/BOOMER OPEN 同步 | `infra/tencent-supabase/ops/systemd/*.timer` | 腾讯自建实例，与本源库无关 | — |
| 打印任务 `print_jobs` + `print_jobs_lease` | 设备端拉取（handheld API），非 cron | 设备侧 | 表内当前无行 |
| GO 授权 outbox `go_scope_sync_outbox` | 应用内触发，无 cron | 应用侧 | 表内当前无行 |

结论：**5 个 cron 里 4 个仍由 Lovable 域执行**，只有 listing-image-worker 已切到腾讯。

## 5. 外部运行依赖与 env 变量名（不含值）

| 依赖 | 代表文件 | 变量名 |
|---|---|---|
| Lovable AI 网关（识别/翻译/关税/包裹解析/上架图/内容） | `src/server/product-recognition.server.ts:332`、`src/server/handheld-ai.server.ts:7`、`src/server/handheld-editorial.server.ts:4`、`src/lib/ai.functions.ts`、`recognize.functions.ts`、`meruki-parse.functions.ts`、`translate.functions.ts`、`tariff.functions.ts`、`domestic-recognize.functions.ts`、`sku-image.functions.ts`、`pack-pieces.functions.ts`、`mobile.functions.ts` | `LOVABLE_API_KEY`、`PRODUCT_RECOGNITION_MODEL`、`HANDHELD_PRODUCT_RECOGNITION_MODEL` |
| Firecrawl 抓取 | 抓取相关 functions | `FIRECRAWL_API_KEY` |
| 有赞固定出口代理 | `src/lib/youzan-http.ts`、`youzan.functions.ts` | `YOUZAN_PROXY_URL`、`YOUZAN_PROXY_TOKEN`、`YOUZAN_PROXY_OUTBOUND_IP`、`YOUZAN_CLIENT_ID`、`YOUZAN_CLIENT_SECRET` |
| 微信普通支付 | `src/server/wechat-ordinary-client.ts`、`ordinary-gateway-config.ts` | `WECHAT_PAY_MCHID`、`WECHAT_PAY_APPID`、`WECHAT_PAY_SERIAL_NO`、`WECHAT_PAY_PRIVATE_KEY`、`WECHAT_PAY_APIV3_KEY`、`WECHAT_PAY_PLATFORM_PUBLIC_KEY`、`WECHAT_PAY_NOTIFY_URL`、`WECHAT_ORDINARY_RECONCILE_TOKEN` |
| 门店收单/分账网关 | `src/server/storefront-payment.server.ts` | `STOREFRONT_PAYMENT_MODE`、`STOREFRONT_PAYMENT_GATEWAY_URL`、`STOREFRONT_PAYMENT_GATEWAY_TOKEN`、`STOREFRONT_PAYMENT_WEBHOOK_SECRET` |
| 支付宝（代码存在） | 支付 server 模块 | `ALIPAY_APP_ID`、`ALIPAY_GATEWAY_URL`、`ALIPAY_NOTIFY_URL`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` |
| 腾讯云短信 | `src/server/sms.tencent.server.ts` | `TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`、`TENCENT_SMS_SDK_APP_ID`、`TENCENT_SMS_SIGN_NAME`、`TENCENT_SMS_TEMPLATE_ID` |
| 消费者身份 JWKS | `src/server/consumer-auth.server.ts` | `CONSUMER_AUTH_ISSUER`、`CONSUMER_AUTH_JWKS_URL`、`CONSUMER_AUTH_AUDIENCE` |
| GO 员工端桥接 | `src/server/go-bridge.server.ts`、`trusted-go-fetch.server.ts` | `GO_SUPABASE_URL`、`GO_SUPABASE_PUBLISHABLE_KEY`、`GO_SUPABASE_ANON_KEY` |
| AIGC SSO | AIGC 路由 | `ERP_AIGC_SSO_SECRET`、`AIGC_PUBLIC_URL` |
| meruki 凭据加密 | meruki server | `MERUKI_ENC_KEY` |
| 主库/存储/鉴权 | `src/integrations/supabase/*` | `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_SECRET_KEYS`、`VITE_SUPABASE_*` |
| 站点自身基址 | `src/lib/sku-media.ts:39`、`src/lib/handheld/openapi.ts:336-338` | `PUBLIC_APP_ORIGIN`、`PUBLIC_SITE_URL`、`ERP_BASE_URL`、`ERP_PORT`、`HOST`、`PORT` |

无语音（TTS/ASR）依赖，源码中未发现。仍硬编码 Lovable 域名的三处：`src/lib/sku-media.ts:39`、`src/lib/handheld/openapi.ts:336-338`、`src/components/youzan/message-push-panel.tsx:26`。

## 6. 未在本地迁移导出中的新 schema migration

`infra/tencent-supabase/migration/` 目录里只有脚本与 `ordinary-expiry-before-20260908.sql` 一个 SQL，不包含平台迁移序列。相对该目录，`supabase/migrations` 下 `20260907191142` 及之后的三个文件未被覆盖：

- `20260907191142_7d0f83df-f771-49f6-a846-10100a7b4151.sql`（有赞订单队列加固）
- `20260908070711_aeaffca7-3783-4447-aff9-2cce0022a31b.sql`
- `20260908081317_3b921feb-3d29-4792-aea4-d644e5375605.sql`（客服顾客上下文只读）

数据库中最新已应用版本即 `20260908081317`，**此后无新增迁移**。

## 7. 未证实事项

- 平台侧是否存在仓库外的历史 Edge Function 部署——代码侧无法证明，待控制台核实。
- 腾讯 `boomer-youzan-sync` / `boomer-ordinary-reconcile` 两个 unit 是否已在生产主机 enable——仓库只有模板文件，实际主机状态未知。
