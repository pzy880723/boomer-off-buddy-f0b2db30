
# Round B · 无感上架打通

## 目标
门店端点「新建自定义 / 组包」或第一次入库标准 SKU 时：
1. 系统自动在**有赞总部**建 SPU（`retail.open.spu.add`），本地 SKU 拿到 HQ 的 `yz_item_id`；
2. 系统自动把这个 SPU **铺货到当前分店**（`retail.open.product.distribute`），拿到 branch `yz_item_id`；
3. 现有 push_stock / push_is_display 队列复用，库存和上下架状态照常同步。

前端观感：门店端还是"我自己上架的商品"，仓库里其实已经有这条 SKU + HQ SPU + 分店铺货关系，未来切自研收银时数据结构完全对齐。

## 核心改造

### 1. 新增 `ensureHqSpu(sku_id)`（youzan-sync.functions.ts）
从现有 `ensureHqSpuLink` 提升成正式流程：
- 已有 `sku_youzan_links(shop=hq)` → 直接返回 `yz_item_id`；
- 否则调 `youzan.retail.open.spu.add`：`product_name / price / stock_num=0 / photo_url / out_product_id=sku.id`（+ HQ 默认 category_id，从 `app_settings` 读，找不到抛清晰错误让用户去设置一次）；
- upsert HQ link（`role=hq_spu`, `sync_stock=false`）。

### 2. 新增 `ensureBranchProduct(sku_id, shop_id)`（youzan-sync.functions.ts）
替代当前的 `ensureBranchListing`：
- 已有 branch link 且 `yz_item_id>0` → 直接返回；
- 否则：先 `ensureHqSpu(sku_id)` 拿到 `hq_item_id`；
- 调 `youzan.retail.open.product.distribute`（HQ token，参数 `kdt_id=hq / target_kdt_id=branch / item_id=hq_item_id`），响应里取 branch `item_id`；
- upsert `sku_youzan_links(shop_id=branch, role=branch_stock, sync_stock=true, yz_item_id=branch_item_id, status=linked)`；
- 失败：upsert 一条 `status=error, last_error=msg` 的 link，返回 `{yz_item_id: null, error}`，走现有重试链路。

### 3. 老 `ensureBranchListing` 收口
- 保留函数签名，实现改为**转调 `ensureBranchProduct`**，去掉 `youzan.item.add`；
- 调用方（worker `runStockSyncWorkerCore` line 626、`shop-products.functions.ts` 3 处、`retryBranchListing`）零改动，语义自然升级为「HQ SPU + 铺货」。

### 4. SKU 创建后台补钩（inventory.functions.ts）
- `createStandardSkus / createCustomSku / createBundleSku` 成功后：
  - 后台 fire-and-forget `ensureHqSpu(sku.id)`；
  - 遍历 `default_shop_ids`（Round A 已落库）为每个分店 `ensureBranchProduct` + 入队 `push_stock target=0`（保证 SPU + 分店铺货在首次入库前就绪）；
- 失败不阻塞创建返回，错误落到 `sku_youzan_links.last_error`，前端已有"上架失败·点重试"的红标。

### 5. 分店 push_stock 走连锁零售接口（youzan-sync.functions.ts）
现在 `pushStockToYouzan` 分店分支走 `youzan.item.quantity.update`（老单店 API）→ 改为 `youzan.retail.open.stock.update`：
```
params: { kdt_id: branch.kdt_id, item_id: link.yz_item_id, num, type: "set", client_seq }
```
`set-status` (`push_is_display`) 保持复用 `retail.open.product.online/offline`（若现有 worker 未实现，同 PR 一并加）。

### 6. UI 恢复门店端「新建标准 / 自定义 / 组包」
Round A 隐藏了门店端「新建标准」入口，本轮把 3 类都放回门店端的「新建商品」下拉：
- 门店端 dialog 提交 → `registerNewSkuAtShop` → 新 `ensureBranchProduct` 自动跑通 HQ SPU + 铺货 + 入库；
- 仓库 `/inventory/skus` 端继续用 `default_shop_ids` 决定要铺哪些分店。

标准商品 tab 保留 Round A 那条「统一在仓库新建」提示条，但不再屏蔽入口——只是引导，不强制。

## 迁移 / 配置
- 无 schema 改动。
- 新增 `app_settings.key='youzan_hq_default_category_id'`（如果 SPU add 强制要求 category）。首次调用发现缺失时抛人类可读错误："请到 `/settings` 配置有赞总部默认商品分类 ID"。

## 验证
1. 门店端新建一条自定义商品 → 观察 3 秒内：
   - `sku_youzan_links` 出现 2 行（hq_spu + branch_stock, status=linked）；
   - 分店有赞后台看得到该商品，库存 = 1。
2. 仓库端新建一条标准 SKU 且 `default_shop_ids=[branchA, branchB]` → HQ + 两个分店 3 条 link，库存 0，红标消失。
3. 手持机对已铺货 SKU 加库存 → `push_stock` 队列 done、分店库存刷新。
4. 现有队列失败重试：把某条 link 手动改回 `status=error` → UI 点重试 → `ensureBranchProduct` 自愈成功。

## 技术备忘
- `retail.open.product.distribute` 具体参数名以有赞真实网关响应为准；实现时先跑一遍 `callYouzanApiVerbose` 打日志，成功后再固化。
- 老 `youzan.item.add` 路径不留兜底——彻底删掉可以避免连锁店铺再撞 `gw 4005`。
- `pushSkuAsNewYouzanItem` / `ensureHqSpuLink` 合并为新 `ensureHqSpu`，导出别名保持向后兼容 `items.smart-create.ts` 调用点。
