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

**仓库未发现**：函数目录不存在，`supabase/config.toml` 只有 `project_id`，无函数配置块；应用后端逻辑都在 TanStack server routes / server functions，随代码仓库走。

但"仓库没有"不能证明平台从未部署过。**平台侧已部署函数清单待 Codex 在控制台核实**（含历史部署但已从仓库删除的函数）。在核实前不下"没有 Edge Function"的结论。

## 5. cron / 队列 / vault 的导出方式

- cron 5 条（定义可从 `cron.job` 读出，SQL 文本已核对）：4 条通过 `pg_net` 回调 Lovable 托管域名（有赞同步已停用、有赞库存 worker、渠道同步 worker、预留过期释放），1 条已指向 `erp.boomeroff.com`。腾讯侧按新域名重建 job 定义。
- `cron.job_run_details` 282,303 行（全部 succeeded，2026-07-02 起）属于全量范围：**先归档导出到腾讯冷存储，再从运行库退出**，不直接丢弃；按行数 + 时间区间对账。
- 队列：业务队列都是 public 表（`youzan_stock_sync_queue` 909、`channel_sync_outbox`、`go_scope_sync_outbox`、`print_jobs` 等），随 public 数据一起走。
- `pg_net`：当前在途请求 **0** 条、`_http_response` 1,440 条。切换前需再次确认在途为 0 并逐条对账，确保没有已发出未落账的 worker 回调，而不是默认忽略。
- vault：1 条 secret（listing-image worker 用）。**vault 密文不能跨实例还原**（加密密钥属于实例），必须在腾讯侧重新写入，值由你方持有。

## 6. 关键结论：一致性全量出口（按通道区分，不要一概而论）

不同通道权限不同，必须分开说：

| 通道 | 实测角色/权限 | 能否读 auth | 能否产出一致性 dump |
|---|---|---|---|
| 我这边的沙箱 `psql` | `sandbox_exec`，受限只读 | 否，`permission denied for schema auth` | 否 |
| 平台 query_database（Codex 侧实测） | `postgres`，可统计 `auth.users` | 是 | 待核实（能否 `COPY`/落盘/流出外部存储未验证） |
| 官方 Export data 入口 | 未验证 | 待核实 | 待核实 |

所以结论只能是：**沙箱不能 pg_dump ≠ 所有通道都读不到 Auth**。既然 `postgres` 角色在平台 SQL 通道可用，Auth 表与 `auth.users.encrypted_password` 很可能可以按表读出；但"能读"与"能生成带 roles/GRANT 的一致性时间点 dump 并直接流向腾讯"是两件事，后者未验证。

**Cloud → Advanced settings → Export data 的实际产物待核实**：是否包含完整 schema DDL、`auth` 密码哈希、数据库 roles/GRANT，还是仅表数据 CSV，我没有验证证据，不作断言。同样待核实的还有是否存在可直接 `psql -f` 导入腾讯的官方格式（`roles.sql` / `schema.sql` / `data.sql` 或 `.dump`）。这几项由 Codex 直接在控制台核实。

- SUPABASE_SERVICE_ROLE_KEY 与数据库超级用户口令对我不可得，我不伪造占位值；Storage 对象本体需你方环境的脚本用 service_role key 拉取。
- 若官方入口不含 roles / auth 哈希，则需向平台申请限时只读连接串（供 `supabase db dump --role-only / --schema / --data`），凭据走私密渠道直达腾讯主机，不进聊天与 Git。`docs/tencent-data-platform-migration.md` 第 99-118 行已备好该请求文本。

## 7. 阻塞项（尚未完成，绝不可称已迁移）

1. Export data 入口的实际内容与格式——**未核实**（Codex 控制台核实中）。
2. 平台 `postgres` 通道能否产出一致性、可导入的全量 dump（含 roles/GRANT）——**未核实**。
3. auth 密码哈希是否可导出——**未确认**；若不可导出，4 个员工账号需重设密码。
4. 平台侧已部署 Edge Functions 清单——**未核实**（仓库内未发现）。
5. Storage 965 MB / 1,211 对象本体未复制 → 需脚本拉取到 COS 并按字节数 + 校验和对账。
6. `cron.job_run_details` 282,303 行历史日志的归档导出未执行。
7. `pg_net` 切换前的在途/已发未落账对账未执行（当前在途 0）。
8. vault 1 条 secret 需在腾讯侧重建（密文不能跨实例还原）。
9. 4 条 cron 仍指向 Lovable 域名，切换时改指并停用源库对应 job，避免双跑重复推库存。
10. AI 能力（商品识别、截图识别、翻译、上架图修整）100% 走 `ai.gateway.lovable.dev`，Lovable 停服即中断，腾讯侧尚无替代实现——这是"完全无运行影响"目标最大的剩余缺口。
11. `infra/tencent-supabase/README.md` 口径落后（记录 106 迁移 / 92 表，现为 140 平台迁移 / 129 表 / 1,211 对象），脚本目录缺 Auth、Storage 对象、vault、cron 重指向四类。

**保持不变（不因搬库更换）**：有赞固定出口代理、现有腾讯支付回调地址与商户配置。切换只需确认回调仍写入新主库，不动出口 IP 白名单与回调域。

## 8. 无法核实的事项

- Lovable 平台侧备份频率、保留期、跨区冗余、停服时数据取出时效——无证据，不当作已备份。
- 平台托管层自身是否有日志/埋点外传，代码内看不到。
