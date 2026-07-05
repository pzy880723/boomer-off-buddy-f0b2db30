## 结论先说

**推荐方案：把有赞 HQ SPU 当成唯一真源，任何 SKU 生命周期只有一条路径**，把你提的两种方案（分店独立建品、仓库建品后再复制）合并成同一个模型。分店端永远不建品，只做入库/上下架，"分配到分店"完全在后台自动完成。用户视角看到的只有仓库和门店，不需要理解"铺货"。

## 一、有赞连锁零售的商品模型（关键前提）

连锁零售版的模型是 **总部 SPU + 分店铺货**：

- 总部（HQ kdt）维护 SPU（标准品档案：名称、图、类目、价格档、条码等），是唯一的商品定义。
- 分店（branch kdt）不能自己新建商品；平台提供"铺货"接口把 HQ SPU 复制成本店可售商品，得到该店独立的 `item_id`。
- 分店的库存/上下架都是操作**它自己的 branch item**，通过 `retail.open.stock.update(kdt_id=branch)` 和 `retail.open.product.online/offline` 完成。
- 分店独立建品在连锁零售平台上就是不允许的（现在的报错 `[gw 4005] 非法的API` 就是这个原因，跟"设置能不能打开"没关系）。

这个约束反过来说明：**分店端有没有"新建"入口只是 ERP 侧的产品决定**，无论怎么做，最终有赞侧都必须走 HQ SPU → 铺货。所以最省心的做法就是把这套顺序内化到 ERP 后台，前端根本不体现。

## 二、统一模型（推荐）

不管标准商品 / 自定义（孤品）/ 组包，全部走同一条链路：

```text
1. 仓库(HQ) 建 SKU
        │
        ▼
2. 后台任务：在有赞 HQ 建 SPU  ── retail.open.spu.add
   → sku_youzan_links(role=hq_spu, shop_id=HQ, yz_item_id=SPU)
        │
        ▼
3. 铺货到分店（懒铺货，用户无感）
   触发时机：第一次要往这家分店产生库存动作时
   （入库 / 调拨到店 / 手持机补货 / set-status）
   → retail.open.product.distribute(HQ_SPU → branch)
   → sku_youzan_links(role=branch_stock, shop_id=分店, yz_item_id=branch item)
        │
        ▼
4. 常规操作
   - 库存 → youzan_stock_sync_queue(action=push_stock)
   - 上/下架 → youzan_stock_sync_queue(action=push_is_display)
```

对比你提的两个方案的差异：

| 场景 | 你原方案 | 统一模型 |
|---|---|---|
| 仓库标准品 | 建完就同步 HQ SPU，分店"用总部 SPU" | ✅ 一致；分店的 branch item 是 SPU 铺货生成的 |
| 仓库建自定义 | 调拨时再复制到分店 | ✅ 调拨触发铺货，语义完全一样 |
| 分店独立上架 | 反推到总部建 SPU + 自动铺回 | ❌ 取消这个入口；仓库建品时勾选"仅铺给 X 分店"即可覆盖 100% 场景 |

**为什么取消"分店独立建品"更好**

1. 有赞侧本来就不给这个能力（`[gw 4005]` 就是这么来的），"反推 HQ + 再铺回分店"要跑两个远程接口，任何一步失败都得回滚，实现复杂、容错难写。
2. 业务上分店店员建"孤品"其实只是"标品档案 + 仅限本店"两个信息，仓库端弹窗多加一个"铺货范围（默认：所有门店 / 仅：分店 A / 分店 B）"多选框，就把整个"分店独立"的诉求吸收掉了。
3. 系统里永远只有一种商品建模方式，减少 bug 面和用户认知负担。

## 三、这一轮不动 UI/数据以外的能力

因为你还在观望，本次只做**决策落地 + 最小改动**，把方向锁定住，具体铺货 API 分开一轮做：

### 本轮做（Round A）

1. **门店商品页 UI 收敛**（就是上一版 plan 已经写的三件事，我把它保留）：
   - Tab 顺序：自定义商品 → 组包商品 → 标准商品，默认「自定义商品」。
   - 「新建商品」下拉去掉"标准商品"入口。
   - 标准商品 tab 顶部加提示条 + `EmptyState` 引导跳 `/inventory/skus`。
2. **仓库端 SKU 弹窗补一个"默认铺货范围"字段**（多选门店，默认全选所有 branch）：
   - `StandardSkuDialog` / `CustomSkuDialog` / `BundleSkuDialog` 都加。
   - 存到 `inv_skus.default_shop_ids uuid[]`（新迁移）。
   - 目前先只存不用；等 Round B 铺货 worker 上线后自动读它。
3. **明确废弃**：把 `src/lib/shop-products.functions.ts` 里的 `registerNewSkuAtShop` 和 `ensureBranchListing`（走 `youzan.item.add`）标 `@deprecated`，注释里指向后续的 SPU + distribute 方案。**先不删**，两条 error 记录仍能在门店列表里看到（保留可诊断）。

### 下一轮做（Round B，不在本次 plan 范围，只是先约定好）

1. **HQ SPU 通道**：写一个 `ensureHqSpu(sku_id)`，调 `retail.open.spu.add`（现在的 `ensureHqSpuLink` 已是雏形，需要把类目/规格/条码等字段补齐），落 `sku_youzan_links(role=hq_spu)`。
2. **分店铺货通道**：写 `ensureBranchProduct(sku_id, shop_id)`，先确认 HQ SPU 已存在（不存在就 ensure），再调 `retail.open.product.distribute`（具体方法名以对接文档为准，可能是 `retail.open.branch.item.add` 或 `chain.product.copy`；对接时按有赞控制台可用的接口挑），拿 branch item_id，upsert `sku_youzan_links(role=branch_stock)`。
3. **触发点全部改走 SPU 路线**：
   - `addShopStock` / `inv_apply_movement` 触发的 `push_stock`：worker 在 push 前先 `ensureBranchProduct`。
   - `set-status` 已建的 `push_is_display`：同样先确保 branch item 存在。
   - 新建 SKU 后台任务：立刻 `ensureHqSpu`，然后按 `default_shop_ids` 排铺货。
4. **移除老路径**：`ensureBranchListing`（`youzan.item.add`）删掉；清理 2 条 error 状态记录。

### 本轮不做但值得记一笔

- 组包商品在有赞侧仍按普通 SPU 建（价格=组包价），拆包扣库存的逻辑保留在 ERP 端。
- 后续如果想让分店店员真的能在手持机上"建"一个孤品，用同样的 SPU + 铺货通道即可，无需再改架构。

## 四、数据模型变动（本轮）

一条迁移：

```sql
ALTER TABLE public.inv_skus
  ADD COLUMN default_shop_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];
COMMENT ON COLUMN public.inv_skus.default_shop_ids IS
  '仓库建品时预设的铺货门店；空数组=铺到所有 branch。Round B 铺货 worker 消费。';
```

`sku_youzan_links.role` 已有 `hq_spu | branch_stock`，不动。

## 五、验证方式

1. `/shop-mgmt/products`：tab 顺序、下拉、提示条、EmptyState 4 处都对。
2. `/inventory/skus` 新建 SKU 时看到"默认铺货门店"多选，保存后能在数据库读到 `default_shop_ids`。
3. 现有门店的入库/上下架流程完全不受影响（Round A 只是收 UI，不动运行时链路）。
4. 那两条 `error` 状态旧记录仍显示"上架失败·点重试"，等 Round B 上线后自动被 SPU 通道自愈或手工清理。

## 六、需要你确认的一个开放项

Round A 里"默认铺货门店"的**默认值**：

- 选项 A：默认**空数组 = 铺给所有 branch**（标准品友好，自定义品要手改）
- 选项 B：默认**只选当前登录用户所属门店**（自定义品友好，标准品要手改）
- 选项 C：**必须显式选**，不给默认（最严格，也最烦）

如果你偏好某一个我就按那个实现；不选的话我按 A 落。
