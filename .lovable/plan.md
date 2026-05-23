## 背景

零售连锁版的实际业务模型（你刚确认的）：

- **订单**：只有**分店**有销售；总部（HQ `153242272`）只做后台管理，没有交易。所以订单同步应**跳过 HQ**，只对 `role='branch'` 的店执行。
- **商品**：总部维护**商品库（SPU 主数据）**并分配给分店；分店只在**网店在售**里出现总部下发的商品，分店自己没有上架权。所以商品同步要分两层：
  1. HQ 拉**商品库**（master）→ 一份完整数据
  2. 每个 branch 拉**门店在售**（哪些主数据被分配到这家店）→ 做"店-货关联"

当前代码全在调微商城接口（`youzan.item.common.search` / `youzan.items.onsale.get` / `youzan.trades.sold.get`），对零售连锁全部 4005，所以一直拉不出来。

## 改动 `src/lib/youzan.functions.ts`

### A. `syncShopItems` — 按 role 分流

- 若 `role='headquarter'`：调 **`youzan.retail.open.spu.query` 3.0.0**（总部商品库 SPU 列表），用 HQ 自己的 token + HQ 的 kdt_id，分页拉全。字段映射：
  - `item_id` ← `spu_id`
  - `title` ← `title` / `name`
  - `price` ← SKU 最低价或 SPU 标价
  - `pic_url` ← 首图
  - `stock_qty` ← 0（SPU 维度没库存）
  - `is_listed` ← true
  - `raw` ← 原始 JSON
- 若 `role='branch'`：调 **`youzan.retail.open.online.spu.query`**（门店在售 SPU），用**总部 token** + 分店 `kdt_id`，分页拉全。字段同上，`is_listed=true`。
- 两个接口都失败时，把 method/code/msg 完整写进 `youzan_sync_logs.error`，不再静默落空。

### B. `syncShopOrders` — 只对分店执行

- 若 `role='headquarter'`：**直接跳过**，`youzan_sync_logs` 记一条 `status='skipped'`, `message='HQ 无销售数据'`。
- 若 `role='branch'`：调零售订单接口，主用 **`youzan.retail.trade.order.search`**，失败 fallback 到 `youzan.retail.trade.search`，两次响应都打进 `sync_logs.error`，避免又盲打。入参：HQ token + 分店 `kdt_id` + `start_update`/`end_update` 时间窗 + 分页。字段映射到 `youzan_orders`：`tid` / `status` / `pay_type` / `buyer_nick` / `total_fee` / `payment` / `num` / `pay_time` / `created_time` / `raw`。按 `(shop_id, tid)` upsert 判重。

### C. 删掉错的死代码

删除文件里这几个 fallback：`youzan.item.search`、`youzan.item.common.search`、`youzan.items.onsale.get`、`youzan.items.inventory.get`、`youzan.item.base.get`、`youzan.trades.sold.get` —— 对零售连锁全部是错的入口，留着只会污染日志。

## 不动

- 表结构：`youzan_shops` / `youzan_items` / `youzan_orders` / `youzan_sync_logs` 字段够用。
- HQ + 分店两条 `youzan_shops` 记录、token 刷新逻辑、UI 入口（手动同步按钮）保留。
- `youzan.shop.get` / `youzan.auth.token` 探活保留。

## 验证

1. 在 `/integrations/youzan`，对 HQ 点同步商品 → 拉到 SPU 商品库；点同步订单 → 看到 `skipped`。
2. 对每个分店点同步商品 → 拉到下发的在售商品；点同步订单 → 拉到该店真实订单。
3. 看 `youzan_sync_logs`：成功条目 `status=success` 且 `count_in>0`；失败的话错误里能看到明确 method+code+msg，直接拿这条去问有赞核对零售-商品/零售-交易权限包。

## 文档同步

更新 `/mnt/documents/youzan-sync-issue-report.pdf` 末尾加一节："**根因已自查**：之前调的是微商城接口，对零售连锁版必返 4005；已切换到 `youzan.retail.*` 系列。如新接口仍 4005，请贵司核对客户端是否开通 **零售-商品库 / 零售-门店在售商品 / 零售-正向交易** 三个能力包。"
