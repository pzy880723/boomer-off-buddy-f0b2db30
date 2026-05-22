## 实施计划

### Step 1 — 把已授权分店导入本地
在 `/youzan` 顶部加 **「从有赞拉取分店」** 按钮：
- 调已有的 `listAuthorizedShopsFromHQ`
- 弹窗列出未导入的 kdt_id，勾选后调 `batchImportShops` 入库

### Step 2 — 商品全量同步
新增 `syncYouzanItems({ shop_id })`：
- 调有赞 `youzan.items.onsale.get` + `youzan.items.inventory.get`（在售 + 仓库），分页 100/页拉完
- 按 `(shop_id, item_id)` upsert 到 `youzan_items`，写 `title / price / stock_qty / is_listed / pic_url / raw`
- 写一条 `youzan_sync_logs(action='items')`

### Step 3 — 订单同步（默认 30 天，可自选范围）
新增 `syncYouzanOrders({ shop_id, start, end })`：
- 默认 `start = now - 30d`，`end = now`；前端可改
- 调 `youzan.trades.sold.get / 4.0.0`，分页 100/页，按 `start_update / end_update` 拉
- 按 `(shop_id, tid)` upsert 到 `youzan_orders`：tid / payment / total_fee / pay_time / created_time / status / buyer_nick / num / pay_type / raw
- 写一条 `youzan_sync_logs(action='orders', count_in, message)`

### Step 4 — UI：每店一个"同步"对话框
门店卡片上加 **「同步」** 按钮，弹出对话框：
- 商品同步：一键全量
- 订单同步：日期范围选择器（默认最近 30 天，可改任意区间），按钮"开始同步"
- 显示进度 + 结果（拉了几条 / 错误）
- 卡片显示 `last_sync_at` + 最近一次日志摘要

### Step 5 — 顶部统计卡显示商品状态
`youzan-stats.functions.ts` 的 `getYouzanSummary` 已经在统计 `listedCount / stockTotal`，把卡片改成「在售商品 / 总库存」即可，无需新查询。

### 文件改动
- 新增：`src/components/youzan/sync-dialog.tsx`（同步对话框）
- 修改：`src/lib/youzan.functions.ts`（加 `syncYouzanItems` / `syncYouzanOrders` / `listAuthorizedShopsFromHQ` 调用入口已有）
- 修改：`src/routes/youzan.tsx`（顶部「拉取分店」按钮、每张门店卡加「同步」按钮、4 张顶部统计卡含义微调）

### 不做的事
- ❌ 暂不接 pg_cron（手动同步跑通后再加）
- ❌ 不写商品图片 CDN 缓存（直接用有赞的 pic_url）
- ❌ 不做订单明细 sub-orders 展开（先只入主单）
