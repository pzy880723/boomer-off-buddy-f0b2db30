
# 腾讯云迁移资产清单（只读盘点 · 生产 Supabase `sxddfcoiaboqcmeviykl`）

> 只做只读盘点。未修改任何代码、数据、认证、存储、Secret 或发布状态。以下所有敏感值（连接串密码、Service Role、JWT Secret、API Key）均隐去，仅列名称/形态。

---

## 1. Lovable Cloud / 内嵌数据库基本信息

- 类型：Lovable Cloud 托管 Supabase（AWS ap-northeast-1 / 东京，Managed by Lovable = true）
- 项目 ID：`sxddfcoiaboqcmeviykl`
- PostgreSQL 主版本：**17.6**（aarch64 Linux）
- 实例规格：Tiny；数据库大小 157.6 MB，数据盘用量 26%，内存 56%，WAL 80 MB，连接 13/60
- 连接串形态（密码隐去）：Pooler `aws-1-ap-northeast-1.pooler.supabase.com:6543`，直连域为 `db.sxddfcoiaboqcmeviykl.supabase.co:5432`
- **是否能拿到直连迁移凭据/完整逻辑备份**：Lovable Cloud 默认**不暴露** `postgres` 超级用户口令与 Service Role Key；面板可通过 Cloud → Advanced → Export data 导出业务数据，但 `auth.*`、`storage.*`、`vault.*`、`realtime.*`、`supabase_functions.*` 的原生备份需向 Lovable 支持申请（详见第 10 项）。**此项无法从项目环境自读，需要 Lovable 官方确认。**

---

## 2. Schema / 表 / 行数 / 大小

**Schema 概览**（从 `pg_stat_user_tables` 抽样）：

| Schema | 概况 |
|---|---|
| `public` | 业务主 schema，~87 张表，最大表 `youzan_orders`（1,892 行 / 8.4 MB） |
| `auth` | Supabase Auth，23 张系统表，用户 4 行、identities 5 行、refresh_tokens 429 行 |
| `storage` | Supabase Storage，6 个 bucket + `objects` 表（对象计数见第 6 项） |
| `extensions` / `vault` / `net` / `cron` / `realtime` / `supabase_functions` | Supabase 平台 schema |

**public 主要业务表**（行数估算 → `pg_stat_user_tables.n_live_tup`）：

- `youzan_orders` 1892 / 8.4 MB
- `japan_parcel_items` 1009 / 856 kB
- `japan_parcels` 270 / 384 kB
- `inv_brands` 186、`inv_categories` 102、`inv_facets` 23
- `meruki_sync_runs` 168、`meruki_raw_captures` 166 / 1.4 MB、`meruki_accounts` 1
- `inv_skus` 162、`inv_sku_classifications` 5、`inv_stocks` 2、`inv_stock_movements` 2
- `youzan_sync_logs` 131、`youzan_items` 16、`youzan_shops` 2、`youzan_stock_sync_queue` 2、`sku_youzan_links` 4、`sku_channel_listings` 0
- `integration_api_probes` 17、`integration_api_registry` 14
- `auth_phone_otp` 7、`aigc_sso_tickets` 2、`user_roles` 4、`app_settings` 3、`inv_locations` 3、`inv_handheld_devices` 4
- POS/Commerce 骨架已建表但大多为 0：`pos_shifts` 1、`pos_registers` 1、`pos_held_carts` 0、`commerce_refunds` 0、`fulfillments` 0、`inventory_reservations` 0、`sku_channel_listings` 0、`commerce_orders`/`commerce_order_items`/`commerce_after_sales`/`commerce_customers`/… ≈ 0
- 其余空表：`stocktake*`、`inv_inbound_*`、`inv_unclaimed_epcs`、`domestic_bulk_orders`、`org_addresses`、`package_evidence`、`user_location_perms`、`inv_handheld_notifications` 等
- 完整清单：见项目 `<supabase-tables>` 上下文（共 ~87 张），迁移前会用 `pg_dump --schema-only` 出完整列表。

**auth schema**（4 用户 / 1 手机 / 4 邮箱，refresh token 429，session 15，identities 5）
**storage schema**：`objects` 表约 1,060 行（见第 6 项汇总）

---

## 3. Extensions / Enum / View / Function / Trigger / Sequence / Cron / Realtime

**Extensions**（8 个）：`pg_cron 1.6.4`（pg_catalog）、`pg_net 0.20.0`（public）、`pg_stat_statements 1.11`（extensions）、`pg_trgm 1.6`（extensions）、`pgcrypto 1.3`（extensions）、`plpgsql 1.0`、`supabase_vault 0.3.1`（vault）、`uuid-ossp 1.1`（extensions）
→ 腾讯云自建 PG 时需自行 `CREATE EXTENSION`；`supabase_vault` 与 Supabase 平台耦合，自建 Supabase 才能保留，TencentDB PG 走 KMS/COS 密钥托管替代。`pg_net` 目前用于 cron 自打回调，需保留或改由外部调度器发起 HTTP。

**Enum 类型**：`public.app_role`（super_admin/hq_operator/store_manager/store_staff/warehouse_staff）；其余 `auth.*`/`net.*`/`storage.*` 属平台 enum。

**View / Materialized view**：`public` 无视图；`auth`/`storage` 平台视图随 Supabase 一起走。

**Functions / RPC**：public 共 ~34 个 `SECURITY DEFINER` / SQL 函数，覆盖 POS、Commerce、Inventory、SSO、Youzan 队列、EAN 生成等（完整列表见 `<db-functions>`）。迁移时随 `pg_dump` 一起走。

**Triggers**：`information_schema.triggers` 返回 0——所有 trigger 全部依附平台 schema（`auth`、`storage`、`realtime`、`supabase_functions`），`public` 用 RPC + 显式调用替代。**这条要与 Lovable 官方复核**，因为部分 owner 属于 `supabase_admin` 的 trigger 不出现在此视图；迁移时以 `pg_dump --schema-only` 为准。

**Sequences**：`public.commerce_order_number_seq`、`public.commerce_after_sale_number_seq`；其余属 `auth`/`cron`/`net`。

**Scheduled jobs (`cron.job`)**——4 条，全部通过 `pg_net.http_post` 回打 `project--<id>.lovable.app/api/public/hooks/*`：
1. `youzan-sync-30min` `*/30 * * * *`
2. `youzan-stock-worker-tick` `* * * * *`
3. `channel-sync-worker-tick` `* * * * *`
4. `commerce-release-expired-every-minute` `* * * * *`
→ 迁移后需在腾讯云替换为 TencentCloud Scheduler / CFS EventBridge / 自建 pg_cron。

**Publications / Realtime**：只有默认 `supabase_realtime`（`puballtables=false`，未把任何表加进去）。当前**未使用实时订阅**，迁移风险低。

**Webhooks**：`supabase_functions.hooks`/`http_request_queue` 未使用（`pg_net.http_request_queue_id_seq` 存在但仅 cron 使用）。

---

## 4. RLS Policy 与 auth.uid / claim 依赖

- `public` schema 共 **118 条 RLS policy**。
- 全部通过 `has_role(auth.uid(), 'app_role')`（`SECURITY DEFINER` 函数）或 `user_id = auth.uid()` 判定，未使用自定义 JWT claim、未使用 `auth.jwt()`。
- POS/Commerce 表大量策略靠 `service_role` 走服务端 RPC，不依赖 `auth.uid()`。
- **自托管 Supabase 可 100% 保留**（`auth.uid()`/`has_role` 语义一致）。
- **TencentDB + 自建 Auth 路线**：需要重写为业务层校验或使用 PostgREST + 自建 JWT issuer，policies 可保留但 `auth.uid()` 必须来自自建 Auth 的 JWT claim。

---

## 5. Auth 配置

- 用户数：`auth.users = 4`（其中 4 有 email，1 有 phone）；`auth.identities`：`email=4, phone=1`；`refresh_tokens=429`，`sessions=15`。
- 登录方式：
  - ERP 员工：手机号伪邮箱（`phoneToEmail`）+ 密码，走 Supabase `signInWithPassword`；OTP 通过自建 `/api/public/auth/otp/*` + 腾讯云短信发送
  - 消费者：**腾讯云已托管**（手机号+微信），JWKS 验证 → 落到 `commerce_customers` / `commerce_customer_identities`，不占用 `auth.users`
  - `configure_auth` 面板可开 Email/Password、Phone、Google/Apple、SAML；当前生产未启用第三方 OAuth
- SMS provider：腾讯云短信（`TENCENTCLOUD_SECRET_ID/KEY`、`TENCENT_SMS_SDK_APP_ID/SIGN_NAME/TEMPLATE_ID`），走自建 `sms.tencent.server.ts`，未使用 Supabase 原生 SMS
- SMTP：未配置自定义 SMTP，用户量 4 无邮件发送场景
- JWT：Supabase 平台管理，Service Role Key 与 JWT Secret **对 Lovable Cloud 用户不可见**（需向支持申请）
- Redirect URL：`https://boomer-off-buddy.lovable.app`、`https://id-preview--<uuid>.lovable.app`（Lovable 面板配置）
- **导出 `auth.users` 后重新登录问题**：
  - 若走 B 路线（自建 Supabase）：把 `auth.users`/`auth.identities`/`auth.mfa_*` 原封 `pg_dump` 到自建实例，同时保留原 JWT Secret，**用户可无感继续用**；若换 JWT Secret，则**必须重登**。
  - 若走 C 路线（自建 Auth）：密码哈希是 bcrypt，可导入自建服务；但 refresh_token/session 必须作废，**用户必须重登一次**。

---

## 6. Storage

| Bucket | public | 对象数 | 总大小 |
|---|---|---|---|
| `parcel-item-images` | ✅ 公开 | 1,041 | 894 MB |
| `sku-listing` | 私有 | 14 | 14 MB |
| `sku-raw` | 私有 | 3 | 4.5 MB |
| `shop-images` | 私有 | 2 | 353 kB |
| `domestic-bulk-attachments` | 私有 | 0 | 0 |
| `domestic-order-screenshots` | 私有 | 0 | 0 |

- 合计约 **1,060 个对象 / ~913 MB**
- Signed URL 依赖：ERP 组件用 `supabase.storage.from(bucket).createSignedUrl(...)` 拿短期访问；`parcel-item-images` 公开桶直接用公网 URL
- **批量导出方式**：Lovable Cloud UI 不提供整桶导出；需要 Lovable 后台通过 rclone / `mc mirror` 从底层 S3 直拉，或由我们用带 Service Role Key 的脚本 `list + download` 落到 COS，**任一方案都需要 Lovable 提供 Service Role Key 或后台协助**（此项无法从项目环境自读）。

---

## 7. Edge Functions / Server functions / Secrets / 定时 / AI / 第三方集成

- **无 Supabase Edge Functions**：所有服务端逻辑用 TanStack `createServerFn` 或 `src/routes/api/public/**` 路由，跑在 Cloudflare Worker（Lovable 托管，`nodejs_compat`）
- 关键公开 API 路径：`/api/public/auth/otp/{send,verify}`、`/api/public/handheld/*`、`/api/public/storefront/*`、`/api/public/pos/*`、`/api/public/hooks/{youzan-sync,youzan-stock-worker,channel-sync-worker,commerce-release-expired,meruki-ingest,youzan-cleanup,youzan-fix-channel,youzan-relist}`、`/api/public/sso/{aigc-ticket,aigc-exchange}`、`/api/public/webhooks/*`
- 定时任务：见第 3 项，全走 `pg_cron + pg_net` → HTTP 回打
- Secrets（**仅名称**，共 14 条）：`AIGC_PUBLIC_URL`、`ERP_AIGC_SSO_SECRET`、`FIRECRAWL_API_KEY`(connector)、`LOVABLE_API_KEY`(managed)、`MERUKI_ENC_KEY`、`TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`、`TENCENT_SMS_SDK_APP_ID`、`TENCENT_SMS_SIGN_NAME`、`TENCENT_SMS_TEMPLATE_ID`、`YOUZAN_CLIENT_ID`、`YOUZAN_CLIENT_SECRET`、`YOUZAN_PROXY_TOKEN`、`YOUZAN_PROXY_URL`
- AI Gateway：Lovable AI Gateway（`ai.gateway.lovable.dev`，通过 `LOVABLE_API_KEY`），用于日本包裹/国内订单/AI 分类识别、handheld AI 识别
- 第三方：腾讯云短信、腾讯云消费者 Auth（JWKS）、有赞开放平台（走自建代理 `YOUZAN_PROXY_URL`）、Firecrawl connector、meruki 官方后台（Cookie 抓取加密 `MERUKI_ENC_KEY`）、ERP↔AIGC SSO（`ERP_AIGC_SSO_SECRET`）

---

## 8. 域名 / 运行时 / Lovable 专有依赖

- 生产：`https://boomer-off-buddy.lovable.app`
- 预览：`https://id-preview--2158bffa-7f82-4bc6-9df9-c59319d262f7.lovable.app`
- 稳定回调：`https://project--<uuid>.lovable.app` 与 `-dev.lovable.app`（当前 4 条 cron 全用它）
- 运行时：Cloudflare Workers + Vite/Nitro build（TanStack Start v1），**非 Node 进程**
- Lovable 专有依赖 → 迁移必须替换：
  - `ai.gateway.lovable.dev` + `LOVABLE_API_KEY` → 腾讯混元 / OpenAI / 自建 gateway
  - `@lovable/*` 客户端包（`lovable.auth.signInWithOAuth` broker）→ 自建 OAuth 回调
  - Cloudflare Worker `nodejs_compat`（无 `child_process`/`sharp`/`fs.watch`/native binding）→ 腾讯云 SCF / CVM / TKE
  - 稳定域 `project--<uuid>.lovable.app` → 自有域名 + TencentDB pg_cron 或 EventBridge
  - Lovable Cloud Secrets 管理面板 → 腾讯云 SSM / KMS
  - Supabase Storage → COS + 自建 signed URL

---

## 9. 三条路线可行性 / 风险 / 推荐顺序

**路线 A：仅 ERP/API 先迁腾讯云，数据库暂留 Lovable**
- 可行性：高。API 层跑在 SCF/TKE，`@supabase/supabase-js` 继续连 Lovable Cloud（东京）
- 风险：跨境（东京 ↔ 上海/广州）RTT 40–80 ms，`pg_cron` 仍在 Lovable 侧；Lovable 面板改动不受控；`ai.gateway.lovable.dev` 依然依赖 `LOVABLE_API_KEY`
- 适用：过渡期 1–2 周，验证运行时兼容性

**路线 B：腾讯云自托管完整 Supabase（DB + Auth + Storage）**
- 可行性：中等。`supabase/postgres` 官方 Docker 可跑；PG17 + `pgsodium/pg_graphql/supabase_vault` 需自建；`auth.users` + JWT Secret 一起迁，用户可无感继续登
- 风险：Storage 需自建 MinIO/COS-adapter；Realtime 目前未用可省；运维压力大；Lovable Cloud 依赖 SB Broker（Google OAuth）必须替换为原生 Supabase provider
- 适用：想保留 Supabase 生态、RLS/Policy 无痛迁移

**路线 C：TencentDB PostgreSQL + 自建 Auth/API/COS**
- 可行性：低—中。RLS 与 `auth.uid()` 需重写；`auth.users` 4 人 + 消费者已在腾讯云，可以接受；`supabase_vault`/Realtime 全部丢弃
- 风险：118 条 RLS 与 34 个 SECURITY DEFINER RPC 需要重构或前置到自建 API；Storage signed URL 全部改 COS STS；SSO/Handheld/POS/Commerce 客户端 SDK 必须换
- 适用：长期最纯净的腾讯云原生方案，但工作量最大

**推荐顺序**：**先 A（1–2 周过渡）→ 再 B（3–6 周稳定期，保 Auth/RLS 无痛）→ 视合规再评估 C（3–6 个月，纯腾讯云）**。当前用户 4 人、DB 158 MB、Storage 913 MB，B 路线一次导入即可完成主体切换，风险最可控。

---

## 10. Lovable 需提供的“正式迁移导出物”

| 类别 | 明细 | 获取方式（需 Lovable 支持配合） |
|---|---|---|
| 数据库 roles | `pg_dumpall --roles-only` | Lovable 支持后台或临时开放 `postgres` 超级用户直连凭据 |
| 数据库 schema | `pg_dump --schema-only --no-owner` 覆盖 `public/auth/storage/vault/realtime/supabase_functions/cron/net/extensions` | 同上；或面板 Export data 的 schema 段 |
| 数据库 data | `pg_dump --data-only` 或 per-schema COPY | 面板 Cloud → Advanced → Export data（业务表）+ 支持后台补 `auth.*`/`storage.*`/`vault.*` |
| Storage 对象清单 | 每 bucket `list objects`（key/size/mime/created_at/updated_at/metadata） | 需 Service Role Key 或 Lovable 后台 rclone/`mc ls` |
| Storage 文件 | 6 bucket 全量文件（~913 MB） | Service Role Key 用 `mc mirror` 到 COS；或 Lovable 支持直拷底层 S3 |
| Auth 配置 | providers 开关、redirect URL、SMTP/SMS 供应商、Password HIBP、JWT expiry | Lovable 面板截图/JSON 导出 + 项目 config.toml |
| OAuth/SMS 密钥 | 名称清单已在第 7 项 | Lovable 面板 Secrets 复制或委托新环境重灌 |
| 环境变量名称清单 | `AIGC_PUBLIC_URL / ERP_AIGC_SSO_SECRET / MERUKI_ENC_KEY / TENCENTCLOUD_SECRET_ID / KEY / TENCENT_SMS_* / YOUZAN_* / LOVABLE_API_KEY / FIRECRAWL_API_KEY` | 已可从 `fetch_secrets` 读名字（值需人工重录到腾讯云 SSM） |
| JWT Secret / Service Role Key | 决定用户是否能免登 | **Lovable Cloud 默认不暴露**，需向 Lovable 官方申请 |
| 回滚快照 | Lovable Cloud PITR/快照时间点 | 需 Lovable 支持在切割日打快照并保留 ≥7 天 |
| cron / RLS / functions 源码 | 已可从项目仓库 + 迁移文件读到 | ✅ 已就绪，无需 Lovable 额外提供 |

---

## 无法从项目环境自读、需 Lovable 官方确认的项

1. `postgres` 超级用户直连密码 / Service Role Key / JWT Secret（决定 B 路线用户免登、Storage 批量导出可行性）
2. Storage 底层 S3 endpoint / bucket 路径（用于最高效批量迁移）
3. 是否可以打 PITR 快照并保留 ≥7 天供切割日回滚
4. `auth`/`storage`/`vault`/`realtime`/`supabase_functions` 上是否存在 owner=`supabase_admin` 的 trigger（本次 `information_schema.triggers` 查不到，需 `pg_dump` 复核）
5. Lovable Cloud 是否允许在导出期间冻结写入 / 提供只读窗口
