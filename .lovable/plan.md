## 两种手持机 · 两种商品 · 两种入库

| 商品类型 | 手持机 | 上架动作 | 入库动作 |
|---|---|---|---|
| **标准商品** | RFID 手持枪 | **不由手持机做** —— ERP Web 打印 RFID 时，芯片内已写入「品名+价格档」，打印本身是「预入库」占位 | RFID 枪扫描贴在商品上的 EPC = **确定入库**（`inv_apply_movement +1` at device.location_id） |
| **自定义 / 组包（孤品）** | 商米 V3 | 由 V3 现场拍照+识别+建 SKU+打标一步完成 | 同一次调用里 `inv_apply_movement +1` |

两种入库最后都落到同一件事：**`inv_apply_movement` 在某个 `inv_locations` 上加库存**。如果该 location 是门店（`kind='shop'`）→ 必须自动同步到有赞。

---

## 目标

**只要 movement 发生在门店库位，就自动做完两件事：**
1. 若这个 SKU 在该门店的有赞店铺还没上架 → 调 `youzan.item.add` 上架 → 建 `sku_youzan_links(sku, shop, item_id)`
2. 调 `youzan.item.quantity.update` 推送当前库存

调用方（RFID 扫描 / V3 建品 / Web 后台调整 / 有赞回调）**都不需要感知有赞**。

---

## 现状差距

- ✅ `/shop-mgmt/products` 新建/调整已经手动串起 `ensureBranchListing + pushStock`
- ❌ RFID `rfid/bind-item`、`rfid/transfer-location`、`stocktake.submit` 只做了 `inv_apply_movement`，没触发有赞
- ❌ 商米 V3 `items/smart-create` 手写了一段 `youzan_stock_sync_queue insert`，但**没写 shop_id / location_id**，worker 会因为找不到 (sku, shop) link 而失败
- ❌ Worker 遇到「没 link」直接抛错，不会自愈上架

---

## 方案：DB 触发器 + Worker 自愈（一次到位，覆盖所有入口）

### 1. DB 触发器 `tg_shop_movement_enqueue`
`AFTER INSERT ON inv_stock_movements FOR EACH ROW`：
- 从 `inv_locations` 读该 location 的 kind + shop_id
- 若 `kind='shop'` → `INSERT INTO youzan_stock_sync_queue (sku_id, shop_id, location_id, target_stock, action='push_stock', reason=NEW.ref_type, status='pending', next_run_at=now())`
- 加一条 partial unique index `(sku_id, shop_id) WHERE status IN ('pending','failed')`，同一 (sku, shop) 只留一条待办，防止连扫产生重复队列

### 2. Worker 自愈上架（`runStockSyncWorkerCore`）
拿到任务后：
```
if (无 sku_youzan_links(sku, shop)):
   调 ensureBranchListing(sku, shop)  // youzan.item.add
   成功 → upsert link → 继续
   失败 → 队列标 failed + 记 last_error（下次 backoff 重试）
else:
   走原路径 push 库存
```
把 `ensureBranchListing` 从 `shop-products.functions.ts` 抽到 `src/lib/youzan-listing.server.ts`，worker 和 dialog 共用。

### 3. 触发 worker 的 3 条路径
- **手持机 endpoints**（`rfid/bind-item`、`rfid/transfer-location`、`stocktake.submit`、`items/smart-create`）：完成 movement 后 `void fetch(/api/public/hooks/youzan-stock-worker)`，fire-and-forget，让门店端秒级同步。抽成 `src/server/handheld-shop-sync.server.ts` 复用。
- **Web dialog**（`shop-products.functions`）：保留 `await runStockSyncWorker`，让用户在 dialog 里立即看到成败。
- **兜底 cron**：`pg_cron` 每分钟 POST 一次 `youzan-stock-worker`（配套迁移里加）。

### 4. 清理旧代码
- `items/smart-create.ts` 里手写的 `youzan_stock_sync_queue insert` **删掉**（DB 触发器接管；此处保留 `ensureHqSpuLink` 因为它是总部 SPU 主数据，不走门店 link）
- `shop-products.functions.ts` 里 `pushStockNow` 简化：不再自己 insert queue（触发器接管），只保留「立即触发一次 worker」的 fire-and-forget

---

## 你要测的 4 个场景（本轮做完后）

1. **Web · 门店选中信泰富 → 新建标准 SKU『陶瓷 9.9 档 · 白瓷杯』** → 卡片立刻出现「已同步有赞」→ 有赞后台中信泰富店出现该商品 · 库存 1
2. **RFID · 手持枪绑到中信泰富库位** → 扫一张已经打印好的 RFID → 绑到「白瓷杯」→ 有赞后台中信泰富店该商品库存 +1
3. **RFID · 从仓库移库到中信泰富** → 走 `transfer` 收货扫描 → 有赞后台中信泰富店该商品库存 +1
4. **商米 V3 · 在中信泰富现场建自定义 SKU『Chanel 手包』并 +1** → 有赞后台中信泰富店立即出现该商品 · 库存 1

任一失败：
- `/youzan → 同步明细` Tab 有 `push_stock` / `item_add` 错误行
- `/shop-mgmt/products` 该商品卡片上出现「上架失败·点重试」

---

## 技术要点

- 触发器 `SECURITY DEFINER + SET search_path=public`
- `youzan_stock_sync_queue` 新增 partial unique index，避免连扫刷屏
- `ensureBranchListing` 放 `.server.ts`（避免打进 client bundle）
- `items/smart-create.ts` 手写的队列 insert 删掉（现在有 shop_id 支持了）
- 迁移只新增：触发器函数 + 触发器绑定 + partial unique index + pg_cron job
- Handheld 响应体保持不变（异步触发 worker，不影响 `stock_after` / 幂等回放）

## Codex 侧

改到了 `/api/public/handheld/rfid/{bind-item, transfer-location, stock-in, batch-stock-in}`、`stocktake.submit`、`items/smart-create` 的内部行为（多了一次 fire-and-forget worker 触发），响应体和现有 openapi 一致，手持机侧**无需改动**。请复用现有场景测。若响应体或错误码有变化，本轮实施完会追加「给 Codex 的指令」块。
