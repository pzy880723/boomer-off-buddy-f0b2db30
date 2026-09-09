# 迁移前只读核对（不改代码/数据库/定时任务/密钥，未触发有赞或支付写入）

## 1. 源项目当前版本与差异

- 源项目 HEAD：`d2a8e671f6fcb27b3edf34da41749fd6412ebc30`（工作区干净，无未提交改动）。
- **`1e7a4ee` 在本项目 git 中不存在**（`fatal: Not a valid object name`）。那是腾讯工作树的提交号，两边历史不同源，不能直接做祖先比较。可对齐的锚点是 `2652b16`（storefront shops 只读接口），它是本项目 HEAD 的祖先。
- 最近 6 次触碰 `src/` 或 `supabase/` 的提交：`2652b16`、`cc3b198`、`2ca80e4`、`77fd798`、`07e14fc`、`b02b92f`。`2652b16` 之后的提交只改了 `.lovable/plan.md`（`d2a8e67`、`ffb0a0a`、`ed40219`、`2e9f4a2`、`a7a4a24`、`590fd3a`、`b6c5323`、`0fab562`），**没有新的源码或迁移改动**。
- 数据库迁移：仓库 `supabase/migrations` 155 个文件；库内 `supabase_migrations.schema_migrations` 140 条，最新 8 条为 `20260908081317`、`20260908070711`、`20260908002040`、`20260908000950`、`20260907231644`、`20260907230036`、`20260907191142`、`20260907190625`。最后一条 `20260908081317` 即客服顾客上下文只读迁移，**此后无新迁移**。

## 2. 线上后台任务：cron 定义 + 路由 + 鉴权变量名（仅名称）

| cron job | 调度 | active | 目标 URL 主机 | 路由文件 | 鉴权 |
|---|---|---|---|---|---|
| `youzan-sync-30min` | `*/30 * * * *` | false | `project--…lovable.app` | `src/routes/api/public/hooks/youzan-sync.ts` | 无头部凭据（已停用） |
| `youzan-stock-worker-tick` | `* * * * *` | true | `project--…lovable.app` | `src/routes/api/public/hooks/youzan-stock-worker.ts:9` | 请求头 `apikey` == `SUPABASE_PUBLISHABLE_KEY` |
| `channel-sync-worker-tick` | `* * * * *` | true | `project--…lovable.app` | `src/routes/api/public/hooks/channel-sync-worker.ts:56-58` | 请求头 `apikey` == `SUPABASE_PUBLISHABLE_KEY`，回退 `SUPABASE_ANON_KEY` |
| `commerce-release-expired-every-minute` | `* * * * *` | true | `project--…lovable.app` | `src/routes/api/public/hooks/commerce-release-expired.ts` | **无鉴权**，处理器直接调用 RPC |
| `listing-image-worker-every-minute` | `* * * * *` | true | `erp.boomeroff.com` | `src/routes/api/public/hooks/listing-image-worker.ts:8-11` | `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`，cron 侧从 vault 取密文 |

需要注意的两处不一致（只报告，不改）：
- `channel-sync-worker-tick` 的 cron 命令**没有发送 `apikey` 头**，而路由端要求匹配，缺失即 401。该 job 当前处于持续 401 的状态。
- `commerce-release-expired` 是唯一无鉴权的公开写入型 hook（触发预留释放）。迁移到腾讯后建议加同款 `apikey` 校验，属于新工作，本轮未实施。
- 5 条 cron 里 4 条仍指向 Lovable 域名，只有 listing-image-worker 已指向 `erp.boomeroff.com`。

## 3. 除 Lovable AI 网关外仍需迁移的运行时依赖

| 依赖 | 代表文件 | 配置变量名（无值） | 可独立 Node/Nitro 运行 |
|---|---|---|---|
| Supabase 主库/Storage/Auth | `src/integrations/supabase/client.ts`、`client.server.ts` | `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_SECRET_KEYS`、`VITE_SUPABASE_*` | 是，指向腾讯自建实例即可 |
| 有赞固定出口代理 | `src/lib/youzan-http.ts`、`src/lib/youzan.functions.ts` | `YOUZAN_PROXY_URL`、`YOUZAN_PROXY_TOKEN`、`YOUZAN_PROXY_OUTBOUND_IP`、`YOUZAN_CLIENT_ID`、`YOUZAN_CLIENT_SECRET` | 是（已在腾讯，保持不变） |
| 普通微信支付网关 | `src/server/ordinary-gateway-config.ts`、`wechat-ordinary-client.ts`、`payment-route.ts` | `WECHAT_PAY_MCHID`、`WECHAT_PAY_APPID`、`WECHAT_PAY_SERIAL_NO`、`WECHAT_PAY_PRIVATE_KEY`、`WECHAT_PAY_APIV3_KEY`、`WECHAT_PAY_PLATFORM_PUBLIC_KEY`、`WECHAT_PAY_NOTIFY_URL`、`WECHAT_ORDINARY_RECONCILE_TOKEN` | 是（已在腾讯，保持不变） |
| 分账/门店收单网关 | `src/server/storefront-payment.server.ts` | `STOREFRONT_PAYMENT_MODE`、`STOREFRONT_PAYMENT_GATEWAY_URL`、`STOREFRONT_PAYMENT_GATEWAY_TOKEN`、`STOREFRONT_PAYMENT_WEBHOOK_SECRET` | 是 |
| 支付宝（代码存在） | 支付相关 server 模块 | `ALIPAY_APP_ID`、`ALIPAY_GATEWAY_URL`、`ALIPAY_NOTIFY_URL`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` | 是 |
| 腾讯云短信 OTP | `src/server/sms.tencent.server.ts` | `TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`、`TENCENT_SMS_SDK_APP_ID`、`TENCENT_SMS_SIGN_NAME`、`TENCENT_SMS_TEMPLATE_ID` | 是 |
| 消费者身份（外部 JWKS） | `src/server/consumer-auth.server.ts` | `CONSUMER_AUTH_ISSUER`、`CONSUMER_AUTH_JWKS_URL`、`CONSUMER_AUTH_AUDIENCE` | 是，签发方在 `auth.boomeroff.com` |
| GO 员工端桥接 | `src/server/go-bridge.server.ts`、`trusted-go-fetch.server.ts` | `GO_SUPABASE_URL`、`GO_SUPABASE_PUBLISHABLE_KEY`、`GO_SUPABASE_ANON_KEY` | 是 |
| AIGC SSO | `src/routes/api/...` + `aigc_sso_tickets` | `ERP_AIGC_SSO_SECRET`、`AIGC_PUBLIC_URL` | 是 |
| Firecrawl 抓取 | 抓取相关 functions | `FIRECRAWL_API_KEY` | 是，外部 SaaS |
| meruki 凭据加解密 | meruki 相关 server | `MERUKI_ENC_KEY` | 是 |
| 站点自身域名/回调基址 | `src/lib/sku-media.ts:39`、`src/lib/handheld/openapi.ts:336-338` | `PUBLIC_APP_ORIGIN`、`PUBLIC_SITE_URL`、`ERP_BASE_URL`、`ERP_PORT`、`HOST`、`PORT` | 是 |
| 同步脚本触发地址 | `scripts/sync-*.mjs` | `ERP_STANDARD_CATALOG_SYNC_URL`、`ERP_CATEGORY_GROUP_SYNC_URL`、`STANDARD_SYNC_BATCH_SIZE`、`STANDARD_SYNC_START_OFFSET`、`CATEGORY_GROUP_*` | 是 |

**仍硬编码 Lovable 域名的位置**（迁移时需改，属新工作）：`src/lib/sku-media.ts:39`（公共图片基址默认 `boomer-off-buddy.lovable.app`）、`src/lib/handheld/openapi.ts:336-338`（OpenAPI servers）、`src/components/youzan/message-push-panel.tsx:26`（消息推送回调展示地址）。
**AI 网关**（不在本节但一并记录）：`ai.gateway.lovable.dev` 出现在 `src/server/product-recognition.server.ts:332`、`handheld-ai.server.ts:7`、`handheld-editorial.server.ts:4`、`src/lib/ai.functions.ts`、`recognize.functions.ts`、`meruki-parse.functions.ts`、`translate.functions.ts`、`tariff.functions.ts`、`domestic-recognize.functions.ts`、`sku-image.functions.ts`、`pack-pieces.functions.ts`、`mobile.functions.ts`，变量 `LOVABLE_API_KEY`。

## 4. 构建是否必须调用 Lovable 服务

- 构建脚本：`package.json` 中 `build` = `vite build`，`build:tencent` = `NITRO_PRESET=node-server vite build`。启动脚本 `scripts/run-tencent-erp.sh` 已支持 `node-server` 预设，直接 `node .output/server/index.mjs`，不需要 Cloudflare/wrangler。
- 唯一 Lovable 相关构建件是 npm 包 `@lovable.dev/vite-tanstack-config@2.13.1`（`vite.config.ts` 唯一导入，devDependency）。可验证依据：`https://registry.npmjs.org/@lovable.dev/vite-tanstack-config` 返回 HTTP 200，即公有 npm 上可获取；本地 `node_modules/@lovable.dev/vite-tanstack-config/package.json` 版本 `2.13.1`。
- 结论：**构建不需要调用 Lovable 平台 API/服务**，只需要能从公有 npm 拉到这个配置包（或在离线环境预置 `node_modules` / 私有 registry 镜像）。该包会内置 componentTagger（仅 dev）与 cloudflare 插件（仅 build），用 `NITRO_PRESET=node-server` 时走 Nitro Node 输出。
- 未验证：该包在纯离线内网环境的完整构建结果（我没有跑构建，本轮只读）。

## 5. 状态小结

- 未同步到腾讯的代码/迁移：**无**（`2652b16` 之后只有计划文档改动，数据库最新迁移 `20260908081317` 已在你方备份范围内）。
- 未实施项（供 Codex 部署时处理）：`channel-sync-worker` 的 cron 缺 `apikey` 头、`commerce-release-expired` 无鉴权、3 处硬编码 Lovable 域名、AI 网关替代方案。
