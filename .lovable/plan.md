## 目标
验证中信泰富分店（已绑定 kdt_id）能否通过有赞 API 正确抓取商品与订单数据，并把结果直接呈现在门店列表页面。

## 步骤

### 1. 现状核对（只读）
- 读 `src/lib/youzan-sync.functions.ts`，确认现有 `syncShopItems` / `syncShopOrders` 是否已按分店 token 走通。
- 读 `src/lib/shops.functions.ts` 的 `listShopsWithStats`，确认 revenue/order/item 聚合口径。
- 查 DB：`youzan_shops`（中信泰富店的 access_token / authorized_at / last_ping_ok）、`youzan_items where shop_id=...`、`youzan_orders where shop_id=...` 当前条数。

### 2. 新增"抓取门店数据"入口（门店卡片上）
在 `src/routes/shop-mgmt.shops.tsx` 每张分店卡片右上角加一个「同步数据」按钮（下拉：同步商品 / 同步订单 / 全部同步）。调用已有的 `syncShopItems` / `syncShopOrders`，天数默认 30 天。
- 成功后 toast 显示「商品 X 条 / 订单 Y 条」，并 invalidate `listShopsWithStats` 让卡片数字实时刷新。
- 失败时把有赞返回的错误码原样展示，方便定位授权/权限问题。

### 3. 卡片上新增可见指标
`ShopCard` 已有本月营业额/订单数/商品数/库存，追加：
- 最近同步时间（`last_ping_at`）
- 授权状态（authorized_at 是否有值 + last_ping_ok 颜色点）

### 4. 端到端验收
按下「全部同步」后检查：
1. `youzan_sync_logs` 里出现两条 ok 记录（items / orders）。
2. `youzan_items` / `youzan_orders` 新增记录，`shop_id` 指向中信泰富。
3. 卡片数字从 0 变为真实值。
4. 若失败，日志里能看到有赞原始 error message（不吞错）。

## 只改这些文件
- `src/routes/shop-mgmt.shops.tsx`：卡片加同步按钮 + 指标。
- `src/lib/shops.functions.ts`：如需要暴露一个"手动触发单店同步"的轻封装才加，否则直接复用现有 serverFn。

不动 API 注册表、不动库存/发布链路、不动侧边栏。
