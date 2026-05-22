## 1. 4 卡 → 单行紧凑条（视觉缩减）

`src/routes/youzan.tsx` 第 159-186 行，把 `grid sm:grid-cols-2 lg:grid-cols-4` 的 `MetricCard` 区块换成一个 `Card` 内部 `flex divide-x` 的一行四栏小条：

- 一行高度从 ~140px 压到 ~56px
- 每栏：图标 + label 一行（10px 灰）+ value 一行（base 半粗，不再 3xl）
- 仍保留 "本月营业额 / 本月订单 / 在售商品 / 总库存"，hint "等待首次同步" 改为右侧 1 行极小灰字、只在无数据时显示
- 移动端 `grid-cols-2`，桌面 `flex`，保持响应式

## 2. 新增"订单管理"侧栏大类

`src/components/app-sidebar.tsx`，在"门店管理"和"运营"之间插入新组：

```
订单管理（icon: ClipboardList）
  ├─ 门店订单    /orders/shops     (有赞 + POS 销售)
  ├─ 铺货订单    /orders/dispatch  (总仓→门店调拨/铺货单)
  └─ 批发订单    /orders/wholesale (B 端批发出货)
```

新建 4 个路由文件（占位骨架，先把入口跑通，不做完整业务）：
- `src/routes/orders.tsx` —— layout，仅 `<Outlet />`
- `src/routes/orders.shops.tsx` —— 接入已有 `youzan_orders`，分门店筛选 + DataTable
- `src/routes/orders.dispatch.tsx` —— 复用 `stock_transfers` 数据，按"铺货"视角呈现
- `src/routes/orders.wholesale.tsx` —— 空骨架 + EmptyState「即将上线」

`NavTo` 联合类型同步加上 4 条新路径。

## 3. 修复有赞商品/订单不同步

**诊断**（已查 DB + 日志）：
- 总部 `153242272` token 正常，`items` 同步成功但返回 **0 条** —— 总部账户名下确实没挂商品，所有商品挂在分店 `187395218`
- 分店 `187395218` 只跑过 `ping`，**从未触发过 items / orders 同步** —— 现有 UI 需要逐店打开 SyncDialog 手动点，用户没意识到分店要单独同步
- `ensureAccessToken` 已支持用分店自己的 `kdt_id` 换 silent token（分店 ping 已成功验证），所以代码层只缺一个"全部同步"入口

**修复方案**（不改底层同步逻辑，加入口 + 自动触发）：

a) `src/lib/youzan.functions.ts` 新增 `syncAllShops` serverFn：
   - 拉所有 `status='active'` 的店铺
   - 对每家串行调 `syncYouzanItems`+`syncYouzanOrders`（近 30 天），失败不中断
   - 返回 `{ shop_id, shop_name, itemsResult, ordersResult }[]` 汇总

b) `src/routes/youzan.tsx` 顶部 PageHeader actions 旁新增「🔄 一键同步全部」按钮，调用 `syncAllShops`，loading 时禁用，结束 toast 显示 "X 家成功 / Y 家失败"，并 invalidate 所有 query

c) `batchImportShops`（lib 已有）末尾追加：导入成功后对新加店铺自动跑一次 `syncYouzanItems`（不跑 orders 避免太慢），把"加了店铺却看不到商品"的疑惑消除在源头

d) `ShopCard` 上若 `youzan_items` 中该 kdt_id 计数为 0，显示一个 amber 小提示「尚未同步商品，点击同步」直接打开 SyncDialog —— 复用现有 `getShopSalesBreakdown` 已经返回的店铺 item 数即可（如果没有，给 summary serverFn 加上 `itemsByShop`）

## 文件改动清单

- 编辑 `src/routes/youzan.tsx`（紧凑条 + 一键同步按钮 + 空商品提示）
- 编辑 `src/components/app-sidebar.tsx`（订单管理 5 行 + NavTo 联合类型）
- 编辑 `src/lib/youzan.functions.ts`（新增 `syncAllShops`；`batchImportShops` 尾部自动同步）
- 编辑 `src/lib/youzan-stats.functions.ts`（summary 加 `itemsByShop` 计数）
- 新建 `src/routes/orders.tsx` / `orders.shops.tsx` / `orders.dispatch.tsx` / `orders.wholesale.tsx`

不动：数据库表结构、RLS、SyncDialog 内部逻辑、`ensureAccessToken`/`callYouzanApi` 底层调用、移动端 `/store`、`/shop-mgmt/*`、`/inventory/*`。

## 后续不在本次范围

- 门店订单全功能（退款/发货回写有赞）
- 批发订单业务建表（先骨架占位）
- 定时任务自动同步（暂时手动 + 一键）
