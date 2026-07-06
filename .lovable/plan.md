## 目标
把两条中信泰富店的自定义商品（`test`、`测试商品`）立即推到有赞。

## 现状确认（已查数据库）
- 两条同步队列都是 `status=failed, attempts=2`，最后错误：`[gw 4005] 非法的API`。
- 对应 `sku_youzan_links` 都是 `yz_item_id=0 / status=error`，说明**连总部 SPU 都还没建成**，卡在自动上架第一步。
- 触发失败的具体接口是 `youzan.retail.open.spu.create`（连锁零售 · 总部建 SPU）。
- `app_settings.youzan_hq_default_category_id` 仍为空，说明 `youzan.item.group.create` 也没能建成默认分组（同样是 4005 场景）。

## 我要做的事（顺序执行）
1. **把两条队列 reset 成 pending**（清空 last_error / attempts / next_run_at=now），让 worker 立刻挑起来。
2. **服务端强行跑一次 `runStockSyncWorkerCore`**，只针对这两个 sku_id，limit=5，把每一步的原始 payload 回传到日志。
3. **逐步推进**：
   - Step A：调 `ensureAutoYouzanDefaultCategory` → `youzan.item.group.create` name=`ERP自动同步`（HQ token）。成功则写回 `app_settings`。
   - Step B：调 `ensureHqSpuLink` → `youzan.retail.open.spu.create` v3.0.0（HQ token，`offline_create=true`，`sell_channel_ids=[中信泰富店 kdt_id]`）。成功则写 `sku_youzan_links(role=hq_spu)`。
   - Step C：upsert 分店 `sku_youzan_links(role=branch_stock, yz_item_id=hq_spu_id, sync_stock=true)`。
   - Step D：`youzan.retail.open.stock.adjust` 把当前 `inv_stocks.qty` 推到中信泰富店。
4. **两种结果分别处理**：
   - 全部成功：把两个 SKU 在有赞后台的直达链接、当前推送库存值贴出来给你确认。
   - 仍然 4005：明确告诉你**是哪一个 API method 被拒**（group.create / spu.create / stock.adjust），因为「App 授权范围」这个开关是必须在有赞开放平台后台勾选对应 API 的授权，这一步只能你本人在开放平台点授权——不是 ERP 能替代的操作。届时我会一次性列出**需要勾选的 API method 全名**，你在开放平台一次勾完就好，之后同步全自动。

## 不改的地方
- 不动库存/SKU/分店信息、不动其它同步流程、不动分类映射逻辑。
- 只操作 `youzan_stock_sync_queue` 和 `sku_youzan_links` 这两条记录的状态。

## 技术细节
- 用 `supabase--insert` 把两条队列 update 成 `status='pending', attempts=0, last_error=null, next_run_at=now()`。
- 通过一个临时 serverFn（或直接扩展 `retryFailedBranchListings` 的入口）以「同步」方式跑一次 worker 并回传详细日志，而不是 fire-and-forget，方便当场看到 Youzan 原始返回。
