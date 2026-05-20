# 解耦"包裹入库"与"分拣入库"

## 业务模型修正

- **包裹入库（已有 m.receive）**：包裹到货 → 拍到货照片 → 标记签收。系统仅记录"这个包裹到了，里面声明的子商品列表如下"，止步于此，不产生任何库存条目、不产生任何待分拣条目。
- **分拣入库（已有 inventory.skus + inventory.inbound）**：与包裹完全脱钩。员工线下拆包 → 拆出最小颗粒商品 → 二次包装 → 在 SKU 详情页打印 RFID 价格标签 → /inventory/inbound/new 扫枪聚合 → 提交入库单，库存累加。

两条流程之间**不存在任何数据/UI 链路**，包裹层面不再追踪"是否分拣完毕"。

## 需要删除/回滚的内容（上一轮做反了的）

1. **路由删除**
   - `src/routes/m.sort.index.tsx`
   - `src/routes/m.sort.$id.tsx`
   - `src/routes/m.sort.item.$itemId.tsx`
2. **mobile.functions.ts** 删除：`listPendingSortItems` / `getPendingSortItem` / `markPendingSortItemDone` / `sortItemToSku`（这一组都是建立在 pending_sort_items 上的）。
3. **markParcelDelivered** 移除"自动 upsert pending_sort_items"的副作用，只更新 parcel 状态/时间线/到货照片。
4. **getMobileCounts** 去掉 `pendingSort` 字段。
5. **m.index.tsx** 去掉「分拣台」磁贴和「待分拣」统计卡；用「扫码入库」入口替代（指向 `/m/inbound` 或 `/inventory/inbound/new`）。
6. **m.receive.$id.tsx** 签收完成后跳回 `/m/parcels`（不再跳到 sort 详情）。
7. **数据库迁移**：`DROP TABLE public.pending_sort_items;`（无业务意义，且会持续产生孤儿数据）。
8. **inv_label_batches.parcel_item_id**：保留列即可（历史数据），新流程不再写入，不强制清理。

## 保留 / 不动

- `japan_parcels` / `japan_parcel_items` 字段不动，子商品列表只是包裹声明信息。
- `inv_skus` / `inv_inbound_orders` / `inv_inbound_lines` / `inv_label_batches` / `inv_apply_inbound_stock` 全部保留。
- `/inventory/skus*`、`/inventory/inbound*` 全部保留，是分拣入库的唯一入口。

## 文件改动清单

```text
删除  src/routes/m.sort.index.tsx
删除  src/routes/m.sort.$id.tsx
删除  src/routes/m.sort.item.$itemId.tsx
迁移  DROP TABLE pending_sort_items
改    src/lib/mobile.functions.ts   去掉 4 个 fn + markParcelDelivered 副作用 + counts.pendingSort
改    src/routes/m.index.tsx        去掉分拣磁贴/统计，新增扫码入库入口
改    src/routes/m.receive.$id.tsx  签收成功 → /m/parcels
```

## 待确认

1. `pending_sort_items` 表是直接 DROP 还是先保留观察？（推荐 DROP，新逻辑下完全没有写入方）
2. 手机首页 5 个磁贴中"分拣台"被移除后，是否用「新建入库单」(`/inventory/inbound/new`) 替代占位？还是直接缩减为 4 个？
