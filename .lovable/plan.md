## 目标

把已经同步的 849 条有赞订单从 raw 中"榨干"，补齐展示所需字段，让 `订单管理 → 门店订单`（`/orders/shops`）一打开就能看到完整信息，不再出现 件数=0 / 买家=— / 没商品 / 没收货 的空白。

## 现状

- 同步链路 OK：`youzan.trades.sold.get` 已稳定返回，849 / 849 入库。
- 但 `youzan_orders` 表只有 11 个业务字段，丢了商品明细、收货人、买家昵称、子单数等。
- `pickStr/pickNum` 在 `flattenTrade` 后拿不到这些字段，因为：
  - `num` 在订单级根本没给，需要按 `orders[].num` 累加；
  - `buyer_nick` 在新接口下叫 `buyer_info.fans_nickname`（部分订单只有 `yz_open_id`）；
  - 商品标题/图片/收货全在嵌套对象，需要单独读，不靠泛搜。

## 方案

### 1. 扩展 `youzan_orders` 字段（migration）

新增列（都可空，老数据兼容）：

| 字段 | 类型 | 来源 |
|---|---|---|
| `buyer_open_id` | text | `buyer_info.yz_open_id` |
| `item_count` | int | `Σ orders[].num` |
| `sku_count` | int | `orders[].length` |
| `item_titles` | text | 前 3 个 `orders[].title` 用 `、` 连接，超出加 "等 N 件" |
| `first_item_image` | text | `orders[0].pic_url` / `pic_thumb_url`（接口字段为 `goods_url` 中拿不到，从 `orders[0].sku_pic_url` 或 raw 里 `pic_url` 取） |
| `receiver_name` | text | `address_info.receiver_name` |
| `receiver_tel` | text | `address_info.receiver_tel` |
| `receiver_address` | text | `province + city + district + delivery_address` 拼接 |
| `outer_transaction_no` | text | `pay_info.outer_transactions[0]` |
| `post_fee` | numeric | `pay_info.post_fee` |
| `status_text` | text | 状态码 → 中文映射（WAIT_BUYER_PAY=待付款、TRADE_SUCCESS=已完成、TRADE_CLOSED=已关闭…） |

加索引：`(shop_id, pay_time desc)`、`(shop_id, status)`。

### 2. 改造同步 mapping（`src/lib/youzan.functions.ts`）

把 trade 里这几块单独抽：

```ts
const fullOrder = (t.full_order_info ?? {}) as any;
const ordersArr = fullOrder.orders ?? [];
const addr = fullOrder.address_info ?? {};
const buyer = fullOrder.buyer_info ?? {};
const payInfo = fullOrder.pay_info ?? {};
```

然后：
- `item_count = ordersArr.reduce((s,o)=>s+Number(o.num||0),0)`，回填到现有 `num` 字段（解决件数=0）；
- `buyer_nick` 优先 `buyer.fans_nickname`，回退 `buyer.outer_user_id`，再回退 `yz_open_id` 末 6 位；
- `item_titles / first_item_image / receiver_* / outer_transaction_no / post_fee / status_text` 按上表填；
- 保留 `raw: t` 全量备查。
- 顺手把状态码→中文表也导出，供前端复用。

### 3. 一次性回填脚本

写一个 `backfillShopOrders` server fn（管理员手动触发一次即可）：遍历现有 849 条 `youzan_orders`，从 `raw` 重新跑一遍 mapping，UPDATE 新字段。完成后在 `/youzan` 页加一个"回填字段"按钮（位置：高级 · 同步明细 里）。后续新同步走改造后的逻辑，无需再次回填。

### 4. 改造 `/orders/shops` 页面

`listShopOrders` 返回结构增加新字段；`DataTable` 列改为：

```
[缩略图] 订单号 / 门店 / 商品摘要(+件数) / 买家 / 收货人 / 金额 / 状态(中文) / 支付时间
```

- 默认按 `pay_time desc` 排序；
- 顶部增加：
  - 搜索框（订单号 / 买家 / 收货人 / 商品名 模糊匹配，本地过滤即可，849 条够用）；
  - 状态筛选（待付款/已付款/已发货/已完成/已关闭/退款中）；
  - 日期范围（最近 7/30/90 天 + 自定义）；
- 行点击展开，显示完整商品清单（从 `raw.full_order_info.orders` 渲染）+ 收货地址 + 支付流水号；
- 列表加分页（25/页）+ 总金额合计。

## 技术说明（细节）

- `youzan_orders` 唯一键已是 `(kdt_id, tid)`，UPSERT 不变。
- 状态码映射放 `src/lib/youzan-status.ts`，前后端共用。
- 回填脚本一次跑完即可，不放 cron。
- `listShopOrders` 当前一次取全部，849 条 OK；超过 5000 时再加 server 端分页（本期不做）。
- 不动同步链路本身（已稳定），只动 mapping 和展示。

## 交付清单

1. migration：`youzan_orders` 加 11 列 + 2 索引
2. `src/lib/youzan-status.ts`（状态映射，新增）
3. `src/lib/youzan.functions.ts`：mapping 重写 + `backfillShopOrders` 新增 + `listShopOrders` 返回新字段
4. `src/routes/orders.shops.tsx`：搜索/筛选/分页/展开行/缩略图/中文状态
5. `src/routes/youzan.tsx`：高级面板加"回填历史订单字段"按钮

验收：打开 `/orders/shops`，849 条订单全部有商品名、件数、买家、收货人、中文状态；点行能看到商品清单。
