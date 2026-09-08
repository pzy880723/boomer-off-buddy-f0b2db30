# 只读审计（两部分）：可售集字段覆盖 + 迁往腾讯主库的依赖清单

本轮不改代码/数据/订单，不迁移、不导出用户数据或密钥、不发布。

---

# A. 真实可售集字段覆盖

可售集口径：`commerce_listings.status='published'` + SKU `status='active'` 且 `is_display` + 对应门店 `inv_stocks.qty>0`（`commerce_listing_availability` 只授权 service_role，用同逻辑复算）。结果 **4 条**，与 Codex 公网一致。

| 字段 | 有值 / 4 |
|---|---|
| 分类 category | 4 |
| 图片 image_paths | 3 |
| 成色 condition_grade（上架层） | 3 |
| 成色 grade（SKU 层） | 3 |
| 关键词 keywords | 3 |
| 属性 attributes | 3 |
| 标签 facets（任一维度） | 3 |
| IP ip_id | 1 |
| 品牌 brand_id | 0 |
| 重量 weight_g | 0 |

可售集标签维度：function 3、era 1、material 1、origin 1、release_method 1、style 1，每个维度目前都只有 1 个取值；craft / object_type / ip / character / series 为 0。
（对照：全部 active+可展示 463 条 → 分类 463、图片 461、属性 37、成色 13、关键词 5、标签 4、IP 1、品牌 0。备注正文未读取。）

## 尺寸/重量/产地/材质/年代/工艺 存放位置

- **仅在 attributes JSON**：`dimensions`（尺寸）、`colors`、`maker`、`functional_status`、`missing_parts`、`origin_region`、`origin_country`、`brand`（文本非外键）——各 3 条有值。
- **attributes 与 facet 双写重复**：`material`、`era`、`craft`、`object_type`、`origin`。
- **独立列**：重量 `inv_skus.weight_g`（0 条）、成色 `commerce_listings.condition_grade` 与 `inv_skus.grade` 并存、`brand_id`、`ip_id`。
- attributes 无 GIN 索引、无接口按它筛选 → 尺寸/颜色/制造者/功能状态/缺件目前**完全不可筛选**；facet 侧有索引且已进 `search_inv_skus`。

## 筛选契约现状（已验证）

`products.ts` 第 18-28 行确实把 `brand_ids`、`facet_codes` 传入 RPC。语义：品牌数组内 OR；facet 同维度内 OR、跨维度 AND；`primary_category` 命中本身或子分类；三者 AND。缺口：`location_id` 不进 RPC，筛选项无计数。

---

# B. 迁往腾讯云中国大陆做权威主库的依赖清单

目标：全部业务数据与运行时落在自有腾讯云账号；Lovable 完全停服后小程序照常运行，Lovable 仅作开发工具，不再持有生产数据依赖。

## 源库现状（可确认值）

- Postgres 17.6，`public` 129 张表、0 视图、84 个函数（其中 SECURITY DEFINER 69 个）、非内部触发器 66 个、RLS 策略 147 条、129 张表已启用 RLS，public 表总大小 23 MB。
- 扩展：`pg_cron`、`pg_net`、`pg_stat_statements`、`pg_trgm`、`pgcrypto`、`supabase_vault`、`uuid-ossp`、`plpgsql`。
- Auth 用户 4 个（员工侧）；消费者身份走外部 JWT（`CONSUMER_AUTH_ISSUER/AUDIENCE/JWKS_URL`），不在本库 auth.users。
- Storage 对象 1211 个：`parcel-item-images` 1139 / 910 MB（公开桶）、`sku-listing` 44 / 33 MB、`sku-raw` 26 / 21 MB、`shop-images` 2 / 353 kB；另有两个私有桶当前 0 对象。
- Edge Functions：`supabase/functions` 目录不存在，**没有任何 Edge Function**，全部后端逻辑在应用侧（TanStack server routes / serverFn）。
- Realtime：代码里没有 `.channel(` / realtime 订阅，客服消息是请求式读取，不依赖 Realtime。
- 迁移脚本 155 个（`supabase/migrations`），最新 `20260908081317_...`。

## 最关键的运行时耦合（Lovable 停服即中断）

`cron.job` 5 条里 4 条通过 `pg_net` 回调 **Lovable 托管域名** `project--2158bffa-...lovable.app`：有赞同步（已停用）、有赞库存 worker、渠道同步 worker、预留过期释放。只有 listing-image worker 已指向 `erp.boomeroff.com`，并从 `supabase_vault` 取密钥。这四条必须改指腾讯域名，且 vault 内密钥要在腾讯侧重建。

## 迁移对象 / 腾讯目标 / 兼容风险 / 验收方式

| 迁移对象 | 腾讯目标 | 兼容风险 | 验收方式 |
|---|---|---|---|
| public 129 表 + 147 RLS + 84 函数（69 SECURITY DEFINER）+ 66 触发器 | 自建 Supabase 兼容栈 Postgres 17.6 | 函数属主与 `search_path` 变化会让 SECURITY DEFINER 行为漂移；GRANT 未随表迁移则 PostgREST 403 | 逐表/策略/函数/触发器数量与定义 diff；对 4 类角色跑权限矩阵读写测试 |
| 8 个扩展（含 pg_cron / pg_net / vault） | 自建栈同版本扩展 | 中国大陆网络下 `pg_net` 出网需白名单；vault 密钥不随 dump 迁移 | `select extname` 比对；vault 密钥重建后触发一次 worker |
| 5 条 cron，其中 4 条指向 lovable.app | 全部改指腾讯 ERP 域名 | 切换期双跑会重复推库存/重复释放预留 | 切换后源库 cron 全部 `active=false`；腾讯侧队列有新记录、旧域名零请求 |
| Storage 1211 对象 / 约 965 MB，4 个在用桶 | 腾讯 COS + Storage API | 公开桶 `parcel-item-images` URL 形态变化；私有桶 signed URL 有效期与 transform（480px 缩略图）能力必须存在 | 对象数与总字节比对；抽样校验缩略图 transform 与私桶签名可用 |
| Auth 4 个员工用户 + 消费者外部 JWT | 腾讯 Auth；JWKS 指向自有签发方 | 密码哈希与 JWT 签名密钥不迁则全员需重设；外部 issuer 若仍是境外服务同样是停服风险 | 4 个账号真实登录；消费者 token 在腾讯侧校验通过 |
| 微信普通支付：下单/回调/查单/退款/对账 | 腾讯云网关（已有），回调域名换成自有域 | `WECHAT_ORDINARY_NOTIFY_URL` 若仍指 Lovable 域，停服即丢回调；切换窗口内在途单需对账兜底 | 回调域解析到腾讯；跑一次对账脚本，无未决单 |
| 有赞：`youzanFetch` 固定出口代理 | 保持腾讯固定出口 IP 代理 | 出口 IP 变化需重新白名单 | 一次真实 code=200 探测 |
| 迁移脚本覆盖 | `supabase/migrations` 155 个可重放 | `infra/tencent-supabase/migration/` 只有 BOOMER OPEN 与普通支付相关脚本，**没有** Auth 用户、Storage 对象、vault 密钥、cron 重指向的迁移脚本；README 记录的是 106 条迁移、92 张表的旧口径，已落后于现在的 155 / 129 | 补齐这 4 项脚本后做一次空实例全量重放 + 计数对账 |

## 第三方 / 跨境外传清单（必须处理）

| 外传 | 用途 | 数据内容 | 停服/合规影响 |
|---|---|---|---|
| `ai.gateway.lovable.dev`（`LOVABLE_API_KEY`） | 商品识别、包裹识别、国内订单识别、翻译、内容生成、上架图修整 | 商品实拍图、订单截图（可能含收件信息）、文本 | Lovable 停服即全部识别功能中断；且这是境外 AI 调用，需换成腾讯云自有模型或境内网关 |
| Firecrawl（`FIRECRAWL_API_KEY`） | 抓取 | 外部网页 | 境外服务，可替换或下线 |
| 腾讯云短信（`TENCENTCLOUD_*`、SMS 模板） | 手机验证码 | 手机号 | 已在腾讯，符合目标 |
| 有赞开放平台（经固定出口代理） | 商品/库存/订单同步 | 商品与订单数据 | 交易合作方本就接触交易数据，这一项无法也不应声称隔离 |
| 微信支付 | 支付/退款/对账 | 交易金额、openid | 同上，交易合作方必然接触 |
| Lovable 预览/托管域名（cron + 应用托管） | 运行时 | 全部业务请求 | 这是最硬的停服依赖，必须先切 |
| 埋点/日志：代码内未发现 Sentry/PostHog 等第三方 SDK | — | — | 平台侧托管日志无法核实，视为需自建日志 |

## 明确的缺口（截至本轮）

1. 四条 cron 仍指 Lovable 域名。
2. 没有 Auth / Storage / vault 的迁移脚本，README 口径落后（106 迁移 92 表 vs 现在 155 迁移 129 表、1211 对象）。
3. AI 能力 100% 依赖 Lovable Gateway，没有腾讯侧替代实现。
4. 没有针对当前托管库的独立导出与恢复演练证据（`ops/backup.sh` 只备份腾讯自建实例）。
5. 支付回调域、有赞代理出口 IP 在切换时需要同步变更，属于有窗口期的动作。

## 未证实事项

- Lovable 平台侧的备份频率、保留期、跨区冗余、停服时数据取出时效——无证据，不视为已备份。
- 托管层是否存在平台自带日志/埋点外传，代码内无法确认。
- 本轮未重复性能测量，未触碰测试商品与有赞同步任务。
