## 方案 A · 继续用有赞，把同步打到"能扛业务"

### 核心契约：本地是单一真源（Source of Truth）

```text
本地 inv_stocks(sku, location)  ──绝对值推送──▶  有赞 (kdt, item)
```

- ERP 这边的 `inv_stocks.qty` 是**唯一权威**；有赞的库存数永远跟着这边走。
- 推送只推**绝对值**（`item_sku.update` set quantity = N），**不推增量** —— 增量会因为重试/丢包/手工调整产生漂移。
- 每次推送之后回拉一次远端 `quantity`，写到 `sku_youzan_links.last_pull_stock`；对账任务定期扫差异自动修复。

### 三大业务场景的落地

#### 1) 入库（仓库 → HQ）

```text
PDA 扫 RFID → /m/inbound 聚合 → inv_apply_movement(+N, location=总仓)
                                         │
              ┌──────────────────────────┴──────────────────────────┐
              ▼                                                     ▼
   SKU 已绑定 HQ item？                                       未绑定？
   入队 sync_queue(target=HQ.kdt,                  入队 sync_queue(action=create_then_bind,
                   item=link.yz_item, qty=新绝对值)             target=HQ.kdt, sku_id)
              │                                                     │
              ▼                                                     ▼
     worker 调 item_sku.update                           worker 先调 item.add 创建商品
     成功后回拉远端 qty 校验                              成功拿到 yz_item_id → 写 link → 再推库存
```

要补的：
- `youzan_stock_sync_queue` 增加 `action` 字段：`update_stock | create_and_bind | create_branch_listing`。
- 入库 hook（`inv_apply_movement` 之后）按"该 SKU 在 HQ 仓库的最新库存"入队，**不再传 delta**。
- 现有"未绑定"逻辑改成自动入队 `create_and_bind`，跑完自动绑 HQ，不用人在 /youzan 页面手工点。

#### 2) 调拨（HQ → 门店）

```text
单据创建 stock_transfers(kind=wh_to_shop, from=总仓, to=分店location)
   │
   ├─ 第 1 步：HQ 出库扫枪
   │     stock_transfer_epcs.ship_scanned_at = now()
   │     status = shipped → 本地暂不动 inv_stocks（先冻结）
   │
   ├─ 第 2 步：门店收货扫枪
   │     stock_transfer_epcs.receive_scanned_at = now()
   │     status = posted →
   │         inv_apply_movement(-N, 总仓)
   │         inv_apply_movement(+N, 分店location)
   │
   └─ posted 时入队 2 条 sync_queue：
         ① target=HQ.kdt,    item=HQ_item,    qty=HQ仓库最新值
         ② target=分店.kdt,  item=分店_item,   qty=分店最新值
            └─ 分店 item 不存在？先 create_branch_listing
               （从 HQ_item 拷标题/价/图，建在分店 kdt 下，写 sku_youzan_links.branch_links[shop_id]）
```

要补的：
- `sku_youzan_links` 由 1:1 改为 1:N（一个本地 SKU ↔ HQ + N 个分店 item），用子表 `sku_youzan_branch_links(sku_id, shop_id, yz_item_id, last_pushed_stock)`。
- 调拨 posted 触发器 / 服务端逻辑同时入队 from 端 + to 端的库存推送。
- 出库扫枪 → 收货扫枪之间的"在途"显示在调拨单详情里；超时自动报警。

#### 3) 销售（门店卖出 → 库存扣减）

```text
有赞门店收银卖单 → 有赞订单 webhook / 轮询 → ERP 收到 trade.created
                                                  │
                                                  ▼
        按 (shop_id, yz_item_id) 反查 sku_youzan_branch_links → 本地 sku_id + location
                                                  │
                                                  ▼
                          inv_apply_movement(-qty, 分店location, ref=youzan_order_xxx)
                                                  │
                                                  ▼
                        把"分店最新绝对值"入队推回有赞分店 item（防漂移自愈）
```

要补的：
- 现有 `youzan_orders` 同步只拉单不联动库存。新增订单写入 hook：识别为"已支付/已完成"状态时落 `inv_apply_movement` 一次（用 `ref_type='youzan_order'` 防重）。
- 退款单同步触发反向 +qty。
- 没绑定 SKU 的有赞 item 卖出 → 落 `inv_unclaimed_epcs` 风格的"待认领销售"列表，让运营手动绑回。

### 可靠性兜底（三层防漂移）

1. **入队 + 重试 worker**：`youzan_stock_sync_queue` 已有 `attempts/last_error`，cron 每 30s 跑一次，指数退避，最多 8 次。
2. **写后即对账**：每次成功推送后立即 `item.get` 一次回拉，对比 `last_pushed_stock` vs `last_pull_stock`，不一致直接标 `mismatch` 进异常面板。
3. **每日全量对账**：现有 `reconcileAllForCron` 扩展为按 (sku × kdt) 维度全扫，差异自动以本地为准回推。

### UI 上要加的入口（都是已有 /youzan 页面的小扩展）

- "未绑定" Tab 增加按钮：**自动创建到 HQ**（一键 create_and_bind，不用手填 item_id）。
- 绑定卡片展示：HQ item + N 个分店 item 的库存阵列（一行一店）。
- "异常" Tab：HQ/分店任一端 mismatch、create 失败、订单未认领 → 都汇总到这里。
- 调拨单详情：右侧时间线显示「ERP 出库 → ERP 入库 → 有赞 HQ 减库存 → 有赞分店加库存」四步状态。

---

### 技术实施清单（按上线顺序）

| # | 改动 | 文件 / 表 |
| - | --- | --- |
| 1 | `sku_youzan_branch_links` 新表 (sku_id, shop_id, yz_item_id, last_pushed_stock, last_pull_stock, last_error) | migration |
| 2 | `youzan_stock_sync_queue` 增加 `shop_id` + `action` 列 | migration |
| 3 | 推送 worker 重写：以 (sku × shop) 为单位，永远推绝对值 + 回拉校验 | `src/lib/youzan-sync.functions.ts` |
| 4 | 入库 hook：`inv_apply_movement` 完成后按 location → 关联 shop_id 入队 | `inventory.functions.ts` / 新增 `enqueueShopStock(sku_id, shop_id)` |
| 5 | 调拨 posted hook：from + to 两端入队 | `stock-transfer.functions.ts` |
| 6 | 分店 item 自动创建：`createBranchListing(sku_id, shop_id)` 从 HQ 拷字段调 item.add | `youzan-sync.functions.ts` |
| 7 | 订单回写库存：`youzan_orders` 同步增加 `applyOrderToStock(order)`，识别 paid/refund | `youzan.functions.ts` |
| 8 | "未认领销售"列表 + 手动绑回 | `/youzan` 新 Tab |
| 9 | 调拨单详情时间线展示有赞推送进度 | `inventory.transfers.tsx` |
| 10 | 全量对账 cron 扩展到 (sku × shop) 粒度 | `youzan-reconcile.ts` |

完整跑通后业务方就能闭环：**进货扫枪即入库即同步、调拨双扫即划账即同步、门店卖出即扣减即同步**，全程不用人去有赞后台点。

---

### 落地前需要你确认 2 件事

1. **分店在有赞那边是不是"独立 kdt + 自己的 item_id"？** 我现在按这个假设设计（看代码里 `youzan_shops.kdt_id` 也是这么存的）。如果你那边其实是"总部统一 kdt + 多网点"模式（多网点 API），分店 item 就不用建，只需要推"网点库存"，要换一套接口。这个差别决定步骤 6。
2. **门店收银是有赞门店收银还是 ERP 自研？** 现在按"门店还在用有赞门店收银，订单从有赞订单流回 ERP 扣本地库存"设计。如果近期就要换成 ERP 自研收银（手机端），步骤 7 改成"本地收银直接 movement，再推有赞"。
