## 目标

明确两类 SKU 在有赞的上架策略，用一套 HQ token 走通「无感上架」：

- **标准 SKU**（`inv_skus.kind='single' + is_standard=true`，或类目下的通用商品）：**全店共享的 HQ SPU**，`sell_channel_ids` 包含所有 `youzan_shops.role='branch'` 的 `kdt_id`。任意分店首次触发 → 建 SPU（如已存在则复用），并把该分店加入 `sell_channel_ids`；后续别的分店再触发只做 append。
- **自定义 SKU**（`inv_skus.is_custom=true`，或 kind='bundle' 组合装等门店独有商品）：**单店独享的 HQ SPU**，`sell_channel_ids` 只包含发起分店。同一 SKU 只在一个分店可售。

两类都用 HQ token 调 `youzan.retail.open.spu.create.3.0.0`，库存都走 `youzan.retail.open.stock.adjust`。

## 判定规则

在 `inv_skus` 上新增判定字段（如已有则复用）：
- `sku_scope`: `'standard' | 'custom'`（默认由 `is_custom` / `kind` 推导，允许人工覆盖）
  - `is_custom=true` → custom
  - `kind='bundle'` → custom
  - 其余 → standard

## 后端改动

### 1. `src/lib/youzan-sync.functions.ts` · `ensureBranchProduct(sku_id, branch_shop_id)`

```text
1. 读 sku + scope
2. 查 sku_youzan_links where sku_id=? and role='hq_spu'
   - 命中 → 拿到 spu_id / yz_item_id
   - 未命中 → HQ token 调 spu.create.3.0.0(offline_create=true,
             sell_channel_ids=[branch_kdt_id])
             upsert hq_spu link
3. 计算目标 sell_channel_ids：
   - standard: 所有 branch shops 的 kdt_id（去重并集，避免漏店）
   - custom:   仅 [branch_kdt_id]
4. 若目标集合 ⊋ 当前 SPU 的 sell_channel_ids
   → 调 spu.update / spu.channel.bind（查文档确认接口名）追加
5. upsert 分店 branch_stock link（yz_item_id 用 spu 下发到该分店后返回的 item_id）
6. 入 youzan_stock_sync_queue（push_stock, target_stock=当前分店库存）
```

### 2. `pushStockToYouzan`

保持已改好的 `retail.open.stock.adjust/3.0.0`（HQ token, type='set', spu_id + sku_id + kdt_id=分店）。无需改动。

### 3. `retryBranchListing` / worker

无需改逻辑，只是复用新的 `ensureBranchProduct`。

### 4. UI 提示

`/shop-mgmt/products` 每行显示 scope 标签（标准/自定义），标准 SKU 在别的分店点上架时提示"该商品已在总部创建，将追加本店销售渠道"。

## 数据模型

- `inv_skus`：加 `sku_scope text check in ('standard','custom')`，默认 trigger 按 `is_custom`/`kind` 推导，允许 UI 覆盖。
- `sku_youzan_links.role='hq_spu'` 一条 SPU 只一条；分店记录仍是 `role='branch_stock'`。
- 无需新表。

## 前置配置（用户操作）

- `inv_categories.youzan_hq_category_id` 至少给会用到的类目填一个真实总部分组 id；或在 `app_settings.youzan_hq_default_category_id` 填兜底。

## 交付顺序

1. Migration：`inv_skus.sku_scope` + 推导 trigger + 回填现有数据。
2. `ensureBranchProduct` 按 scope 分支写 `sell_channel_ids` + append 逻辑。
3. UI 标签 + 提示。
4. 清理旧 error links / 重置 queue，让 worker 自动重跑现有 2 条测试 SKU。
