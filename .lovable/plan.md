# 全量迁移腾讯云：只读导出可行性核查

本轮只读。未修改源库、未冻结业务、未发布、未删除、未切换，未回传任何客户明细、凭据、哈希或签名链接。

## 1. 实例事实

- 项目 ref：`sxddfcoiaboqcmeviykl`（`supabase/config.toml` 同值），Lovable Cloud 托管。
- PostgreSQL 17.6，数据库总大小 321 MB，连接池区域 `ap-northeast-1`（东京）。
- 平台迁移记录 140 条（`supabase_migrations.schema_migrations`），仓库 `supabase/migrations` 155 个文件。

## 2. 对象与行数清单

| schema | 表数 | 说明 |
|---|---|---|
| public | 129 | 业务全量，活跃行合计 12,535 |
| auth | 23 | 用户 4、identities 5、sessions 21、refresh_tokens 639、MFA 0 |
| storage | 8 | buckets 6、objects 1,211 |
| cron | 2 | job 5、job_run_details 282,303（全部 succeeded，最早 2026-07-02，最新 2026-09-09） |
| net | 2 | `http_request_queue` 在途 0 条、`_http_response` 1,440 条（滚动窗口） |
| vault | 1 | secrets 1 条（只计数，未读取） |
| realtime | 1 | 无应用侧订阅 |
| supabase_migrations | 1 | 140 条 |

public 其他对象：函数 84（SECURITY DEFINER 69）、非内部触发器 66、RLS 策略 147、129 张表全部启用 RLS、0 视图。扩展 8 个：pg_cron、pg_net、pg_stat_statements、pg_trgm、pgcrypto、supabase_vault、uuid-ossp、plpgsql。

行数最多的表（前 10）：youzan_sync_logs 3,679、youzan_orders 2,026、sku_youzan_links 1,360、sku_channel_listings 1,303、japan_parcel_items 1,100、youzan_stock_sync_queue 909、inv_skus 528、japan_parcels 292、inventory_sale_events 201、inv_brands 187。非商城业务表（日本包裹、国内采购、meruki、有赞、手持、客服、POS、会员、门店目标）都在这 129 张内，不会漏。

消费者身份：`commerce_customers` 2 行，独立于 auth.users 的 4 个员工账号；消费者 JWT 由外部签发方（`CONSUMER_AUTH_ISSUER/JWKS_URL`）负责，源库不存密码。

## 3. Storage（含实际字节）

| 桶 | 权限 | 对象数 | 字节 |
|---|---|---|---|
| parcel-item-images | 公开 | 1,139 | 910 MB |
| sku-listing | 私有 | 44 | 33 MB |
| sku-raw | 私有 | 26 | 21 MB |
| shop-images | 私有 | 2 | 353 kB |
| domestic-order-screenshots | 私有 | 0 | 0 |
| domestic-bulk-attachments | 私有 | 0 | 0 |

合计 1,211 对象、约 965 MB。`storage.objects` 只是元数据，**对象本体必须另走 Storage API 拉取**：服务端用 service_role key 逐路径 `download`（或按前缀 `list` 后批量下载），落到腾讯 COS，再用对象数 + 逐对象字节数和 SHA256 对账。本项目 `SUPABASE_SERVICE_ROLE_KEY` 在服务端环境中存在（仅确认存在，未读值），可由运行在你方环境的脚本使用；Lovable 侧不提供 S3 迁移凭证。

## 4. Edge Functions

`supabase/functions` 目录不存在，`supabase/config.toml` 只有 `project_id`，没有任何函数配置块。**本项目没有已部署的 Edge Function**，全部后端逻辑在应用侧（TanStack server routes / server functions），随代码仓库走，无平台侧未导出函数。

## 5. cron / 队列 / vault 的导出方式

- cron 5 条（定义可从 `cron.job` 读出，SQL 文本已核对）：4 条通过 `pg_net` 回调 Lovable 托管域名（有赞同步已停用、有赞库存 worker、渠道同步 worker、预留过期释放），1 条已指向 `erp.boomeroff.com`。迁移做法是在腾讯侧按新域名重建，不建议整表搬运；`cron.job_run_details` 28 万行是历史日志，建议不迁。
- 队列：业务队列都是 public 表（`youzan_stock_sync_queue` 909、`channel_sync_outbox`、`go_scope_sync_outbox`、`print_jobs` 等），随 public 数据一起走。`net.http_request_queue` 是运行时表，不迁。
- vault：1 条 secret（listing-image worker 用）。**vault 密文不能跨实例还原**（加密密钥属于实例），必须在腾讯侧重新写入，值由你方持有。

## 6. 关键结论：一致性 pg_dump 全量出口

- 我可用的数据库连接是受限只读角色（`sandbox_exec`）：实测 `select count(*) from auth.users` 返回 `permission denied for schema auth`。因此**我无法产出包含 auth / roles 的一致性 dump**，也不能代你把数据流向外部存储。
- SUPABASE_SERVICE_ROLE_KEY 与数据库超级用户口令在 Lovable Cloud 上对我不可得，我不会伪造占位值。
- 官方可用替代路径（需要你在产品里操作）：**Cloud → Advanced settings → Export data**，导出业务数据。该入口只导出、不导入。
- 因此 **auth 密码哈希、数据库角色/GRANT 归属、vault 密文、storage 对象本体** 这四类无法通过我这条通道导出，需要平台侧提供限时只读连接串（供 `supabase db dump --role-only / --schema / --data`）或官方 roles.sql + schema.sql + data.sql，凭据走私密渠道直达你方腾讯主机，不进聊天与 Git。仓库里 `docs/tencent-data-platform-migration.md` 第 99-118 行已经写好这份一次性请求文本，可直接发给平台。

## 7. 阻塞项（尚未完成，绝不可称已迁移）

1. 平台侧限时只读连接串或官方三段式导出——**未获得**，这是全量迁移的硬前置。
2. auth 密码哈希未导出 → 否则 4 个员工账号需重设密码。
3. Storage 965 MB 对象本体未复制 → 需你方脚本用 service_role key 拉取到 COS 并对账。
4. vault 1 条 secret 需在腾讯侧重建。
5. 4 条 cron 仍指向 Lovable 域名，切换时必须同时改指并把源库这几条停用，避免双跑重复推库存。
6. AI 能力（商品识别、包裹/订单截图识别、翻译、上架图修整）100% 走 `ai.gateway.lovable.dev`，Lovable 停服即中断，腾讯侧尚无替代实现。
7. 支付回调域 `WECHAT_ORDINARY_NOTIFY_URL`、有赞代理出口 IP 需在切换窗口内同步变更并重新白名单。
8. `infra/tencent-supabase/README.md` 口径落后（记录 106 迁移 / 92 表，现为 140 平台迁移 / 129 表 / 1,211 对象），迁移脚本目录里没有 Auth、Storage 对象、vault、cron 重指向这四类脚本。

## 8. 无法核实的事项

- Lovable 平台侧备份频率、保留期、跨区冗余、停服时的数据取出时效——无证据，不当作已备份。
- 平台托管层自身是否有日志/埋点外传，代码内看不到。
