
## 根本原因（有赞官方已确认）
- **连锁分店无权自建商品**。分店 token 调 `item.add` / `retail.open.spu.create` 都会返 `gw 4005 非法的API`，这就是当前 2 条 error 的来源。
- **正确姿势**：用**总部 token** 调 `youzan.retail.open.spu.create.3.0.0`，通过 `sell_channel_ids` 指定"这个 SPU 可在哪些分店销售"。只勾一家 = 分店独占；勾多家 = 多店共享。
- **必传 `offline_create=true`**——否则只建 SPU 不上架销售（有赞回帖原文）。
- **库存同步**：用 `youzan.retail.open.stock.adjust`（不是 `item.quantity.update`，也不是 `retail.open.stock.update`——后者对连锁网店会报"只有门店或独立仓可以进行库存操作"）。
- **能力包**：确保总部应用授权勾选了「商品库商品管理」/「零售商品」/「库存管理」这几个能力包。

## 一句话流程
所有 SPU 都在总部建，分店的"独立商品"= 总部建的 SPU 只把当前分店 kdt_id 放进 `sell_channel_ids`。前端交互不变（分店照常"新建商品"），后台永远用 HQ token 调有赞。

## 后端改造（4 处）

### 1. `youzan-sync.functions.ts` · `ensureBranchProduct(sku_id, shop_id)`
- 一律用 HQ shop 的 access_token（`SELECT ... FROM youzan_shops WHERE role='hq'`）。
- 若 sku 已存在 `sku_youzan_links(role='hq_spu')` → 复用 `yz_item_id`；否则调 `youzan.retail.open.spu.create` **v3.0.0**（HQ token）：
  ```
  {
    "title": sku.name,
    "outer_id": sku.sku_code,
    "category_id": app_settings.youzan_hq_default_category_id,
    "price": sku_price_yuan,             // 从 price_tier 换算
    "stock_num": 0,
    "offline_create": true,              // ← 关键，必传
    "sell_channel_ids": [branch_kdt_id], // ← 只放本分店 = 分店独占
    "sku": [...],
    "images": [sku.image_url]
  }
  ```
- 返回 `{spu_id, item_id}` → upsert 两条 `sku_youzan_links`：
  - `role='hq_spu', shop_id=HQ, yz_item_id=spu_id, sync_stock=false, status='linked'`
  - `role='branch_stock', shop_id=branch, yz_item_id=item_id or spu_id, sync_stock=true, status='linked'`
- 如果 SPU 已存在，只需把新分店追加到 `sell_channel_ids` → 调 `youzan.retail.open.spu.update.3.0.0`（增量方式），再 upsert branch link。

### 2. `pushStockToYouzan` 换接口
```
POST /youzan.retail.open.stock.adjust/3.0.0   (HQ token)
{
  "kdt_id": branch_kdt_id,        // 目标分店
  "spu_id": hq_spu_id,
  "sku_id": branch_sku_id,        // 有赞侧 sku（不是我们本地 uuid）
  "adjust_num": target_stock,     // 绝对量（type=set），或增量（type=inc/dec）
  "type": "set"
}
```
不再调 `item.quantity.update` / `retail.open.stock.update`。

### 3. `youzan_shops` / `sku_youzan_links` 数据补齐
现有 branch link 的 error 记录一次性清掉 + 队列重跑：
```sql
DELETE FROM sku_youzan_links WHERE status='error' AND yz_item_id=0;
UPDATE youzan_stock_sync_queue
   SET status='pending', attempts=0, last_error=NULL, next_run_at=now()
 WHERE status='failed';
```

### 4. `app_settings`
确认 `youzan_hq_default_category_id` 已经填了一个真实的总部商品分组 id（去 /settings 页面看；空的话第一次调 spu.create 会报 40010 参数错误）。

## 验证步骤
1. 迁移 + 代码上线。
2. 在 /shop-mgmt/products（中信泰富店）点两条测试 SKU 的"点重试"。
3. 期望：sku_youzan_links 出现 2 条 hq_spu + 2 条 branch_stock（status=linked, yz_item_id>0），queue 变 done，有赞总部后台看到 2 个 SPU，且只在"中信泰富店"可售、库存=1。
4. 如失败，日志里 `last_error` 会带真实 trace_id，据此再微调 `sell_channel_ids` / `offline_create` / 能力包。

## 不做的事
- 不再尝试用分店 token 自建 SPU（有赞禁止，白费力气）。
- 不再调 `item.add` / `item.quantity.update` / `retail.open.stock.update` 走连锁路径。
- 前端不改：新建按钮和 3 个 tab 保持现状，用户无感。
