## 你说得对

`youzan.item.quantity.update/4.0.0` 就是"把某个分店商品的库存改成 X"最直接的接口，和你已授权的能力也对上。现在卡住的 `retail.open.stock.adjust/3.0.0` 是「库存调整单」，它需要 `adjust_type`（1 入 / 2 出 / 4 盘点）而不是我们默认推断的 type=3，所以一直报 `123000104 不支持的库存更新类型:3`。改成 4.0.0 之后规则很简单：

- `type=0` 全量覆盖（我们想要的），`type=1` 增量。
- 参数只认 `item_id` + `sku_id`（都是分店那一侧的 id），不接受 `spu_id`。
- 必须用**分店自己的 access_token**调，用总部 token 会直接失败——这是有赞社区里明确说过的坑。

我们表里 `role='branch_stock'` 的 2 条正好都有 `yz_item_id=6046780206/6044984028` 和 `yz_sku_id=513698518/513695650`，正是分店那侧的 id，直接可用。

## 实施步骤

### 1. 改 `pushStockToYouzan`（`src/lib/youzan-sync.functions.ts`）
- 换成：`youzan.item.quantity.update` / `4.0.0`。
- token 用 `link.shop_id` 对应的**分店** token（不再用 HQ token）。
- 参数：
  ```
  {
    item_id: link.yz_item_id,
    sku_id : link.yz_sku_id,   // 无 sku 就省略
    quantity: max(0, target),
    type: 0                    // 全量覆盖
  }
  ```
- 干掉 `resolveYouzanWarehouseCode` / `stock.adjust` 那套 order_items 逻辑；仓库码只有 retail 系接口才需要。
- 报错时把有赞原文完整写入 `sku_youzan_links.last_error` 和队列的 `last_error`，方便排查。

### 2. 复位那 2 条卡死的队列并跑一次 worker
- 把 `youzan_stock_sync_queue` 里 `test` / `测试商品` 两行改回 `status='pending', attempts=0, next_run_at=now(), last_error=null`。
- 立刻 `POST /api/public/hooks/youzan-stock-worker`（已有路由）触发消费。
- 成功后回报：两条 link 的最新 `last_pushed_stock` 和 `status`，并把有赞返回的 `trace_id` 贴给你，你可在中信泰富店商品页看到库存变成 1。

### 3. 收尾登记
- 把 `src/lib/youzan-api-registry.ts` 里 `item.quantity.update` 那行版本从 `3.0.0` 更新到 `4.0.0`，capability 描述里注明"分店 token + type=0 全量"。
- 在回复末尾按老规矩追加一条 `【给 Codex 的指令 · 2026-07-08 · 第N条】`，说明：
  - 新的分店库存写入契约（method/version/参数/token 归属）。
  - 老的 `retail.open.stock.adjust/3.0.0` 分支只作为 fallback 或彻底移除。

## 不做

- 不动 HQ SPU 创建、分组创建、SPU 反查这些已经跑通的逻辑。
- 不动仪表盘、UI、店铺配置。
- 不需要你到有赞后台点任何按钮；如果分店 token 因某种原因失效，我会先自动刷新一次再报错，只有需要**你本人**重新授权时才会请你去点。