# 一次性把有赞 API 全量对接 + 健康巡检 + 固定出口代理做完

分成三块交付，都在这一轮完成，之后不再反复：

## A. 有赞 API 全量清单（登记 + 巡检）

新建 `src/lib/youzan/api-registry.ts`，把 ERP 需要的每一个有赞接口登记成一条记录，字段包括：

- `key`：内部代号，例：`hq.spu.query`
- `method` / `version`：例：`youzan.retail.open.spu.query` / `3.0.0`
- `scope`：`hq` / `branch` / `both`
- `feature`：属于哪块业务（`shop_info` / `category` / `product_master` / `product_online` / `stock` / `trade` / `logistics`）
- `capability_name`：有赞后台"应用能力"里对应的中文名，便于你去后台核对
- `doc_url`：有赞开放平台文档地址
- `required`：这个接口是否是 ERP 现在业务必需
- `probe`：一个只读探测函数，用最小参数（如 `page_no=1, page_size=1`）调用，返回 `ok / gw_code / message / latency_ms`

现有在用的接口先全部登记（下面"技术要点"里列全清单），再按有赞开放平台文档补齐我们还没接但你能力已经开通、后面确定要用的：
- 门店 / 员工 / 库位：`youzan.retail.shop.list.query`、`youzan.retail.shop.query`、`youzan.shop.get`、`youzan.shop.list.get`
- 类目 / 分组：`youzan.itemcategories.tags.get`（3.0.0，一二级 tag）、`youzan.itemcategories.shop.get`（兜底）
- 商品 SPU：`youzan.retail.open.spu.query`（HQ 3.0.0）、`youzan.retail.open.online.spu.query`（分店 1.0.0）、`youzan.retail.open.spu.add`（HQ 新建）
- 库存：`youzan.retail.open.stock.update`（连锁总部/带 kdt_id）、`youzan.item.quantity.update`（分店直推 type=1/2/3）
- 交易：`youzan.trades.sold.get`（分店 offline_id 过滤）
- OAuth：`/auth/token`（client_credentials + `kdt_id`）
- 物流 / 售后 / 打印 / 优惠券 / 会员：先只登记但 `required=false`，探测按钮可用于"你后台开通能力后立刻验证一下通不通"

## B. `/youzan` 页面新增"API 接口状态"面板

在 `/youzan` 主页新增一个 Card：**"有赞 API 能力体检"**

- 顶部：一个"全量巡检"按钮 + 上次巡检时间 + 概览统计（全部通过 / 部分能力未开通 / IP 未白名单 / 授权失败）
- 表格按 `feature` 分组，行显示：
  - 中文能力名 + API method + version
  - 每家连锁门店一列（复用 `youzan_shops`），展示图标：✅ / ⚠️(gw 4005 能力未开通) / ⛔(gw 4007 IP 未白名单) / 🔒(token 失败) / — (不适用该 scope) / 🕓 (未测)
  - 悬停显示原始 gw code、message、latency
- 展开某行可看：文档链接、原始响应节选、"复制未开通能力名去有赞后台开通"按钮

后端加一个 server fn `runYouzanApiHealthCheck({shop_id?})`：遍历 registry，按 scope 选择用哪家店的 token 探测，串行 + 每接口 2s 超时，结果一次性返回（不落库，避免又要一堆表；后续需要历史再加）。

对接错误统一分类：
- gw `4001/4003` → 授权失败
- gw `4005` → 能力未开通（明确告诉你要去哪里开哪个能力名）
- gw `4007` → IP 未白名单（提示走固定出口代理）
- gw `50000+` → 有赞侧异常
- HTTP 非 200 → 网络/代理问题

## C. 固定出口代理接入（在 A/B 之后统一收口）

- 把 `youzan.functions.ts`、`stock-transfer.functions.ts`、`categories.functions.ts`、`youzan-sync.functions.ts` 里所有直连 `fetch(open.youzanyun.com…)` 全部改成走 `youzanFetch`（`src/lib/youzan-http.ts` 已经写好），包括 OAuth token 请求（token 交换也要固定 IP，否则有的接口 token 是新 IP 拿的）。
- registry 里的 probe 直接用 `youzanFetch`，天然经过代理。
- 顶部状态条显示：当前出口模式（直连动态 / 固定代理）、代理 host、`YOUZAN_PROXY_OUTBOUND_IP`、一键复制。
- 部署代理服务器的完整 Codex 指令我上一轮已经给过了（见 A 上方消息），本轮不重复；等你把三个 secret（`YOUZAN_PROXY_URL` / `YOUZAN_PROXY_TOKEN` / `YOUZAN_PROXY_OUTBOUND_IP`）配好，体检面板会自动切换到"固定出口"模式。

## 交付验收

1. `/youzan` 打开可见「API 能力体检」，点"全量巡检"→ 每个已在用接口对每家门店都跑一遍，红/黄/绿一目了然。
2. 任意接口报 gw 4005，直接告诉你去有赞后台开哪个能力（中文名 + 文档链接）。
3. 报 gw 4007 时提示走固定出口代理，且提示已经不是"再加一个动态 IP"。
4. 配好代理 secret 后，同一按钮再跑一次，全部走代理 IP，不再看到 4007。

## 技术要点（给自己看）

- registry 探测参数需要最小副作用：SPU 查询 `page_size=1`；库存更新用 `type=1, quantity=0` 是有副作用的，**改成只探测读接口**，库存写接口的健康标记以"最近一次真实推送成功时间"代替，避免误动库存。
- OAuth token 走 `client_credentials`，`kdt_id` 用每家店自己的（现在 `getShopAccessToken` 已经支持）。
- probe 结果不落库先返回内存结果，UI 用 `useQuery` 缓存；如果你后面想要历史趋势，再加 `youzan_api_probe_runs` 表。
- 不动 `sku_youzan_links` / `youzan_stock_sync_queue` / `youzan_shops` 表结构。

```text
[/youzan API 能力体检]
├─ 出口: 固定代理 proxy.example.com  IP 1.2.3.4  [复制]
├─ 上次巡检: 12:31:04       [全量巡检]
├─ 门店信息
│  ├─ youzan.shop.get                 总部 ✅  分店A ✅  分店B ✅
│  └─ youzan.retail.shop.list.query   总部 ✅
├─ 类目/分组
│  └─ youzan.itemcategories.tags.get  总部 ✅  分店A ⚠️4005 [复制能力名]
├─ 商品
│  ├─ youzan.retail.open.spu.query           总部 ✅
│  └─ youzan.retail.open.online.spu.query    分店A ✅  分店B ⛔4007
├─ 库存 (只读探测)
│  └─ 最近推送成功时间: 分店A 12:20  分店B 昨日
└─ 交易
   └─ youzan.trades.sold.get           分店A ✅  分店B ✅
```
