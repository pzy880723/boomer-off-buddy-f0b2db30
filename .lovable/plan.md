## 目标

「API 对接」页只做一件事：**逐个精准测试每一条平台 API 是否配对正确、是否联通**。别的花架子全砍掉。

---

## 一、页面结构

路由：`/admin/api-integration`

```text
┌────────────────────────────────────────────────────────────┐
│ 平台:  [ 有赞 ● ]  [ 美团 (未接入) ]  [ 淘宝 (未接入) ]     │
├────────────────────────────────────────────────────────────┤
│ 店铺:  [ 总部 BOOMER OFF ▼ ]   ← 影响需要 shop 的测试     │
├────────────────────────────────────────────────────────────┤
│ 能力矩阵（每行一个能力，一行一次测试）                      │
└────────────────────────────────────────────────────────────┘
```

只有两级：**平台 Tab → 能力列表**。没有别的 Tab，没有别的面板。

同步日志、系统检查、实时推送、渠道同步异常，全部删除入口（`ShopHealthPanel` / `ApiHealthPanel` / `SyncCenterPanel` / `MessagePushPanel` / `admin.channel-sync.tsx`）。

---

## 二、能力矩阵一行的字段

每行是**一个业务能力 = 一个 API 调用**，不合并、不复用、不重复。

| 列 | 内容 |
|---|---|
| 能力名 | 精准业务描述，例如「获取分店近 24 小时已支付订单列表」 |
| 需求描述 | 一句话说清：调用谁的 token、传什么关键参数、期望返回什么、系统哪里在用 |
| 当前 API | `youzan.trades.sold.get / 4.0.4` |
| 作用域 | HQ / 分店 / 都可 |
| 测试参数 | 一个小表单，行内展开，字段随能力不同而不同（下面详列） |
| 上次结果 | ✓/✗ + gw code + trace_id + 耗时 + 响应片段（点开看完整 JSON） |
| 操作 | [测试] [编辑 API] [恢复默认] |

**「编辑 API」**：只允许改 `method` / `version` / `scope`，不改语义。改完立即可测，也可一键回滚到代码内置默认。

**「测试参数」按能力精准设计**，绝不再用"最小 dummy 参数"糊弄：

- 获取 token → 无参数
- 拉分店订单 → `time_range=近 24h`、`page_size=1`（可改）
- 拉订单详情 → `tid`（下拉：最近 20 单）
- 拉分店商品 → `page_size=1`
- 商品详情 → `item_id`（下拉：分店最近同步到的 items）或手填
- 建 HQ SPU → 用一个固定「探测用 SKU」草稿参数（测完自动删）
- 更新 HQ SPU 销售渠道 → `spu_id`（下拉：本地 sku_youzan_links）+ 目标 `sell_channel_id`（下拉：门店树）
- 分店库存覆盖 → `item_id` + `num`（默认 0，改回原值二次点回滚）
- 上传素材图 → 选一张本地已存图，返回 CDN URL
- 门店树查询 → 无参数
- 删除 HQ SPU → `spu_id` 手填，二次确认

每次测试的**请求参数、原始响应、trace_id** 全部保存在 `integration_api_probes` 里，可以往回翻。

---

## 三、能力清单（有赞，首发版）

按业务分组，每组每行都是一个**独立**的 API，不做「一键全测」。

**认证**
1. 获取店铺 access_token（silent） · `youzan.retail.open.token.silent/1.0.0`

**门店 / 渠道**
2. 查询门店树 & 销售渠道 · `youzan.retail.open.shoptree.query/3.0.0`

**订单（分店 token）**
3. 拉取分店近 24h 已支付订单列表 · `youzan.trades.sold.get/4.0.4`
4. 拉取单笔订单详情 · `youzan.trade.get/4.0.2`

**商品（HQ token · 中台）**
5. 创建 HQ SPU · `youzan.retail.open.spu.add/3.0.0`
6. 更新 HQ SPU（含铺货 sell_channel_setting_request） · `youzan.retail.open.spu.update/3.0.0`
7. 删除 HQ SPU · `youzan.retail.open.spu.delete/3.0.0`
8. 查询在售 SPU 列表 · `youzan.retail.open.online.spu.query/…`

**商品（分店 token · 前台 item）**
9. 分店商品详情（HQ SPU → 分店 item_id 反查） · `youzan.item.detail.get/1.0.0`
10. 分店库存全量覆盖 · `youzan.item.quantity.update/4.0.0`

**素材**
11. 上传商品图到有赞 CDN · `youzan.materials.storage.platform.img.upload/3.0.0`

以后加美团/淘宝就是往同一张表里插 `platform=meituan` 的新行，Tab 自动多一个。

---

## 四、后端

1. 新表 `integration_api_registry`：`platform, capability_key, capability_name, requirement, method, version, scope, note, is_overridden, updated_at, updated_by`。代码里 `src/lib/youzan-api-registry.ts` 提供内置默认，页面读取时用 DB 覆盖。
2. 新表 `integration_api_probes`：`capability_key, shop_id, request_params, http_status, gw_code, trace_id, latency_ms, ok, response_snippet, tested_at, tested_by`。用于「上次结果」和历史回看。
3. 新 serverFn（都带 `requireSupabaseAuth` + admin 校验）：
   - `listIntegrationCapabilities({ platform })`
   - `updateIntegrationCapability({ capability_key, method, version, scope })`
   - `resetIntegrationCapability({ capability_key })`
   - `probeIntegrationCapability({ capability_key, shop_id, params })` — 按 capability 走对应真实调用路径（复用现有 `callYouzanApiVerbose`），把入参/出参完整落盘。
4. **业务代码改造**：`youzan-sync` / `omnichannel-publish` / `stock-transfer` / webhook 里所有 method/version 硬编码，改为 `await getCapability('trade.get').method` 这样按 key 读。这样你在页面改 API，业务立刻切换，不用发版。

---

## 五、"默认自动同步"

不进入本页 UI，只做后台配置：
- 已有的 `channel-sync-worker` cron 保留。
- 新增两条 pg_cron：
  - 每 5 分钟拉一次所有已绑分店近 30 分钟订单（走能力 3+4）
  - 每 30 分钟拉一次分店在售商品（走能力 8/9），校准 `youzan_items` 与 `sku_channel_listings`
- 门店卡片保留「立即同步」按钮做兜底。

自动同步用的就是矩阵里当前配的 API，一旦你在矩阵里换了 method/version，cron 也跟着换。

---

## 六、删掉的东西

- `admin.api-integration.tsx` 现有的 5 个 Tab（health / api-health / sync / realtime / logs / channel）全清空，只留新的矩阵。
- 路由 `admin.channel-sync.tsx` 删除。
- 侧栏若还有旧入口一并去掉。

---

## 交付验收

- 打开 `/admin/api-integration` 直接看到平台 Tab + 能力矩阵。
- 11 条能力每条都能独立测，参数表单和能力语义严格对应，没有一个是「dummy 通用探针」。
- 任一能力测失败，可就地改 method/version 再测，不用发版。
- 业务代码不再有硬编码的 method/version 字面量（除内置默认表）。
