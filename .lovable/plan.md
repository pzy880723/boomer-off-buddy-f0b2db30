## 目标
从有赞连锁各门店拉取「本月订单 + 本月营业额」，展示在系统里，让你随时能看到实时销售数据。

## 方案

### 1. 数据来源（有赞 API）
使用连锁门店订单接口（走已有的 `youzanFetch` 固定 IP 代理）：
- `youzan.trades.sold.get`（3.0.0）— 按 `start_created`/`end_created` 拉本月订单，分页
- 字段取 `tid / status / payment / pay_time / buyer_nick / num`
- HQ 用主 token 拉全量；分店用各自 token 拉本店；避免重复计费按 `shop_id` 归属

### 2. 新增表 `youzan_orders`（如已存在则复用）
```
id uuid, shop_id uuid → youzan_shops, tid text unique,
status text, pay_time timestamptz, payment numeric,
buyer_nick text, num int, raw jsonb, synced_at timestamptz
```
+ RLS + GRANT + 索引 `(shop_id, pay_time)`。

### 3. 同步 serverFn
`syncYouzanOrders({ shop_id?, since?, until? })`：
- 默认拉「本月 1 号 00:00 → 现在」
- 分页 upsert 到 `youzan_orders`
- 记录到 `youzan_sync_logs`
- HQ 权限触发；支持"全部门店"批量

### 4. 定时任务
`/api/public/cron/youzan-orders`（Bearer 校验），每 15 分钟增量拉取最近 2 小时窗口，由用户在服务器上挂 cron 或 pg_cron 调用。

### 5. 展示
- **仪表盘新卡片「有赞本月」**：本月营业额（已付款 payment 求和） / 本月订单数 / 环比上月 / 按门店拆分小柱状
- **`/youzan` 新 Tab「营业数据」**：门店维度表格（本月 GMV / 订单数 / 客单价 / 最近同步时间）+「立即同步」按钮
- 只统计 `status in (WAIT_SELLER_SEND_GOODS, WAIT_BUYER_CONFIRM_GOODS, TRADE_FINISHED, TRADE_SUCCESS)` 即已付款订单，排除已关闭/退款

## 确认点
1. 「营业额」= 已付款订单 `payment` 总和（含运费），退款不扣减；如果你要扣退款需要再接 `refund` 接口。要不要现在就一起接？
2. 定时同步频率 15 分钟够吗？还是你希望手动点按钮就好，不挂 cron？
3. 仪表盘卡片放在最上面一行「日本小包 / 国内小包 / 国内大宗」旁边，作为第 4 类「有赞门店销售」，可以吗？
