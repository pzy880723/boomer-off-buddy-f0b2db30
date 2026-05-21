
# 有赞**连锁**对接计划（总部 + 分店双后台）

## 关键背景：连锁系统的"两层 kdt_id"

有赞连锁的数据模型是：
- **总部店铺（HQ）**：有自己的 `kdt_id`，**商品库**在这里统一维护，下发到分店；连锁配置、加盟商关系也在总部。
- **分店店铺（Branch / 网点）**：每家分店各有自己的 `kdt_id`，**订单、会员、门店库存**都挂在各自的分店 kdt_id 下。
- 自用型应用的 `client_id` + `client_secret` 是一对，但**每一个 kdt_id 都要单独授权一次**，授权后用 `grant_type=silent` + `kdt_id` 换出该店专属的 `access_token`，调谁的 API 就用谁的 token。

你截图里授权的 `BOOMER OFF vintage / kdt_id=153242272` ——从名字像是**总部**（或者主店）。但**只授权一家不够**，需要在有赞云"自用型应用 → 测试店铺/授权信息" 里**把总部 + 5 家分店都加进来**，每家点一次授权。

> ⚠️ 待你确认：153242272 是总部 kdt 还是某家分店？决定下面 API 调用归到"总部"还是"分店"那一栏。

## 推荐的数据模型

```
youzan_shops                    -- 一行 = 一个 kdt_id（总部或分店）
  kdt_id (unique)
  shop_name
  role            ── 'hq' | 'branch'
  parent_kdt_id   ── 分店指向总部，总部为空
  status, access_token, refresh_token, token_expires_at
  authorized_at, expires_at
```

未来加新分店：在有赞云后台授权一次 → 在本系统 `youzan_shops` 里 insert 一行（`role='branch', parent_kdt_id=总部kdt`），所有 server function 自动覆盖。

## 调用归属对照（哪类数据找谁要）

| 数据 | 调谁的 token | 典型 API |
|---|---|---|
| 商品库（spu/sku、上下架） | **总部** | `youzan.items.onsale.get` / `youzan.item.add` |
| 商品库存（总仓） | **总部** | `youzan.item.sku.update.stock` |
| 门店列表 / 网点信息 | **总部** | `youzan.retail.store.queryall` |
| 订单 | **分店**（每家分别拉） | `youzan.trades.sold.get/4.0.0` |
| 门店实际库存 | **分店** | `youzan.retail.store.stock.query` |
| 会员 / 储值卡 | **总部**（连锁会员通常归总部） | `youzan.scrm.customer.search` |
| Webhook 订阅 | 按事件挂到对应 kdt | 后台「消息订阅」 |

## 分阶段实施

### Phase 0 — 基础设施
1. `add_secret` 让你输入 `YOUZAN_CLIENT_ID` + `YOUZAN_CLIENT_SECRET`。
2. 迁移建表：`youzan_shops`、`youzan_sync_logs`、`youzan_webhook_events`。先插入总部一行（153242272，待你确认 role）。
3. server fn `getYouzanAccessToken(kdtId)`：自用型 `oauth/token?grant_type=silent`，缓存到 `youzan_shops`，到期前 5 分钟自动 refresh。
4. server fn `pingShop(kdtId)` → 调 `youzan.shop.get` 验证联通。
5. 把 `/stores/youzan` 现有 mock 页面改成真实数据：店铺列表（总部+分店）+ 每家「测试连接」按钮 + 同步日志表。

### Phase 1 — 拉门店列表 + 拉订单（最小闭环）
6. server fn `syncStoresFromHq()`：用总部 token 调 `youzan.retail.store.queryall`，把所有分店 upsert 进 `youzan_shops`（自动建立 parent/child 关系）。**这一步可以让你免去手工录 5 家 kdt**——但前提是每家分店仍要在有赞云后台逐一点"授权"按钮。
7. 表 `youzan_orders` + `youzan_order_items`（字段对齐 `youzan.trades.sold.get/4.0.0`）。
8. server fn `pullYouzanOrders({ kdtId, sinceMinutes })`：增量按 update_time，upsert 入库 + 写 `youzan_sync_logs`。
9. UI：`/stores/youzan` 加「立即同步全部分店订单」按钮 + 新页面 `/stores/youzan/orders` 列表（可按分店过滤）。
10. **定时拉取**：`/api/public/youzan-cron-pull-orders`（带 secret token 校验），pg_cron 每 5 分钟跑一次，遍历所有 active 分店。

### Phase 2 — 商品 / 库存 双向同步
11. `inv_skus` 加列 `youzan_hq_item_id`（总部商品 ID）。
12. server fn `pushSkuToYouzanHq(skuId)`：用**总部 token** 调 `youzan.item.add`，回写 ID。
13. 本地入库（`inv_apply_inbound_stock` RPC）后写入 `youzan_stock_push_queue`，pg_cron 每 1 分钟 flush 到**总部** `youzan.item.sku.update.stock`，总部会自动下发到分店。
14. （可选）拉分店实际库存对账：`youzan.retail.store.stock.query`。

### Phase 3 — Webhook
15. `/api/public/youzan-webhook`，校验签名后写 `youzan_webhook_events` + 触发订单状态更新。
16. 回调 URL 我会基于 `project--{id}-dev.lovable.app` 给你，你贴到有赞后台「消息订阅」。
17. 推荐先订阅：`TRADE_ORDER_STATE_CHANGE`、`TRADE_REFUND_STATE_CHANGE`、`ITEM_UPDATE`。

## 落地顺序建议

**先 Phase 0 + Phase 1 的前半段**（基础设施 + 自动拉分店列表 + 测试连接），让你看到 5 家店都连通；
**再 Phase 1 后半段**（拉订单）；
Phase 2 商品/库存推送等订单稳定后再开。

## 需要你确认 / 提供的事项

1. **kdt_id=153242272 是总部还是分店？** 总部 → 直接当 HQ 用；如果是分店 → 你需要在有赞云后台把总部那家也加一次授权（必需，否则商品库读不到）。
2. **5 家店现在是否都已经在有赞云"测试店铺/授权信息"里授权过？** 没有的话需要先去后台逐一点授权，自用型应用不能用代码代办这一步。
3. 同意现在让我 `add_secret` 写入 `YOUZAN_CLIENT_ID` + `YOUZAN_CLIENT_SECRET`？

回复确认这 3 点，我就可以切到 build 模式直接开 Phase 0。
