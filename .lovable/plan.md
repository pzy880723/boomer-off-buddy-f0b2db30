
## 目标

1. 把签收页的「到货照片」改名为「包裹照片」，文案引导拍面单 / 多角度 / 破损存证。
2. 在子商品详情里新增「到货照片」区，每个子商品可独立记录多张到货图。
3. 两处都复用现有的拍照管线：拍一张 / 连拍续拍 / 相册多选；最多 9 张。

## 数据层

新增字段（迁移）：
- `japan_parcel_items.arrival_photo_urls jsonb not null default '[]'::jsonb` — 子商品到货图数组。

包裹层面照片继续沿用现有方案——`markParcelDelivered` 时写入 `status_timeline` 的 `photo_urls`，无需新增列。只是 UI 文案语义改为"包裹照片"。

新增 server function（`src/lib/mobile.functions.ts`）：
- `updateItemArrivalPhotos({ item_id, photo_urls[] })` — 直接覆盖更新该子商品的 `arrival_photo_urls`。

## UI 改造

### A. `src/routes/m.receive.$id.tsx`
- 标题区文案：「到货照片（必填，最多 9 张）」→ 「包裹照片（必填，最多 9 张）」，副标改为「请拍清楚面单、外箱多角度、如有破损一并记录」。
- 其余拍照/连拍/picker 逻辑保持不变。

### B. `src/components/mobile/item-detail-sheet.tsx`
- 在详情底部新增「到货照片」区块。
- 抽出复用的小组件 `PhotoUploaderGrid`（放在 `src/components/mobile/photo-uploader-grid.tsx`）：
  - 入参：`value: string[]`、`onChange(urls)`、`max`、`uploadFn(file) => Promise<string>`、`label`。
  - 内含：缩略图网格 + 删除按钮 + "添加"按钮 + 同款的 拍一张 / 连拍 / 相册多选 底部 picker。
- 在 ItemDetailSheet 里：
  - 接收/缓存 `arrivalPhotoUrls`，初值来自 `item.arrival_photo_urls`。
  - 任何变化即调用 `updateItemArrivalPhotos`（debounce 不必，按"上传成功 / 删除"事件触发）。
  - 同步刷新 `["mobile-parcel", id]` 查询。
- `ItemDetailValue` 类型补 `arrival_photo_urls?: string[] | null`。
- 把签收页 `m.receive.$id.tsx` 里现成的连拍逻辑提取到 `PhotoUploaderGrid` 内部，签收页改用同一个组件，避免重复代码。

### C. 读取链路
- `getJapanParcel`（`src/lib/japan-parcel.functions.ts`）的 `japan_parcel_items` select 列表追加 `arrival_photo_urls`，确保详情 sheet 能拿到现有数据。

## 不动的部分
- 上传桶仍用 `parcel-item-images`（`uploadParcelImage` 现有函数）。
- 签收按钮逻辑、异常逻辑、status_timeline 写入逻辑都不改。
- 桌面端的小包裹详情页不在本次范围内（如需后续同步显示子商品到货图可单独追加）。

## 验收
- 子商品弹层里能拍/连拍/批量上传到货图、能删除、刷新页后仍在。
- 签收页文案变成「包裹照片」，引导文案出现。
- `arrival_photo_urls` 在 DB 中正确累加，不影响现有 RLS。
