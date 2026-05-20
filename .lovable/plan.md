## 目标

打造一条手机端贯穿的商品业务链工作流，覆盖**采购到货 → 分拣分装贴 RFID → 扫码入库**三个环节，外加**拍照识图找包裹/找均价**。门店端单独做 `/store` 子站，先只做"收货确认 + 我店库存查询"，调拨留 V2。

## 两个独立 PWA

```text
/m       仓库 + 采购通用工作台（不分角色，所有功能瓦片直出）
/store   门店专用（登录后只看到本店相关数据）
```

两站都只加 manifest.webmanifest + 图标，不启 Service Worker（遵循平台 PWA 规范，避免预览 iframe 缓存污染）。桌面浏览器也能打开调试，移动端给二维码"添加到主屏幕"。

## /m 主站结构

```text
/m                      首页：5 个业务阶段瓦片 + 今日待办计数
/m/scan                 通用扫码入口（条码 / 二维码 / RFID 蓝牙枪 / OCR）
/m/parcels              小包裹搜索列表（按单号、订单号、商品名）
/m/receive/$parcelId    到货签收：清单 + 强制外包装照片 + 状态时间线 + 异常标记
/m/sort                 分拣台首页：今日已签收待分拣包裹清单
/m/sort/$parcelId       分拣详情：列出子商品 → 每件扫/打 RFID → 形成 inv_skus
/m/inbound              扫枪聚合入库（复用现有 /inventory/inbound/new 的扫码逻辑，移动端 UI）
/m/photo-search         拍照识图（MVP 方案 A：AI 直接对比）
```

### 1. 到货签收 `/m/receive/$id`

- 头部：包裹卡 + 子商品缩略图（`toThumbUrl(item, 256)`）
- 三个动作：
  - **拍外包装照** → 压缩后上传 `parcel-item-images/receive/{parcelId}/{uuid}.webp`，URL 写入 `status_timeline`
  - **一键签收** → `status='delivered'`、`received_at=now()`、`status_timeline` 追加 `{step,at,operator,photo_url}`
  - **异常** → `is_problem=true` + 备注 + 拍照

### 2. 分拣台 `/m/sort/$parcelId`（新增的关键环节）

这是把"日本小包裹的子商品"翻译成"inv_skus 库存"的桥梁。

流程：
1. 扫包裹单号 / 从待分拣列表进入
2. 屏幕列出 `japan_parcel_items`（每行：缩略图、中文名、数量、单价、品类提示）
3. 对每一行点击"拆分为 SKU"：
   - 自动按 `kind` 推断（pack_pieces>1 即 `pack`，否则 `single`）
   - 默认带入 `name = item_title_cn`、`category`（从子商品 raw_payload 或人手选）、`price_tier`（从 `item_total_cny` 推档位）、`image_url=item_image_url`、`weight_g`
   - **关键**：复用现有 EPC 规则——按"类目+价格档+品名"查重，存在则复用，否则新建 SKU
   - 调用打印桥/蓝牙打印机出 RFID 标签（这一步沿用现有 `inv_label_batches` 逻辑）
4. 操作员把 RFID 贴到实物上，扫一下 RFID 校验绑定 → `inv_label_batches.status='applied'`
5. 全部分拣完 → 包裹 `status='completed'`，时间线追加 `sorted_at`

不改 `japan_parcel_items` 表结构；只新增 `inv_label_batches.parcel_item_id`（uuid，可空）做关联溯源。

### 3. 扫码入库 `/m/inbound`

直接复用现在已经能跑的 `inv_apply_inbound_stock` RPC。手机版只是把扫枪输入框聚合 EPC、按 SKU 分组、提交一次 RPC。

### 4. 拍照识图 `/m/photo-search`

MVP 方案 A（保持上一轮已确认）：压缩图 → server fn 取最近 200-400 件 `japan_parcel_items` 缩略图 → 喂 `google/gemini-3-flash-preview` 一次对比 → Top 5 命中（包含包裹号、商品名、均价、商品现有 SKU 关联）。

## /store 子站

```text
/store                  本店首页：在途待收 / 库存件数 / 今日销售（占位）
/store/incoming         待收货清单（来自 V2 调拨；MVP 阶段先空着或显示提示）
/store/inventory        本店 SKU 库存查询（按 EPC、品名、类目搜索）
/store/scan             扫 RFID / 条码定位单件商品（看采购均价、来源包裹）
```

由于"调拨"留到 V2，门店端 MVP 主要做**库存查询和单件溯源**。底层共用 `inv_skus`，等 V2 给 `inv_skus` 加 `location` 字段后再按门店过滤。

## 数据库变更

最小化，只加 1 列 + 1 个可选字段：

```sql
-- 关联分拣出的标签到原始子商品，便于溯源
ALTER TABLE public.inv_label_batches
  ADD COLUMN parcel_item_id uuid;

-- 给签收/分拣的步骤一个统一存放位置（已存在则跳过）
-- japan_parcels.status_timeline 已是 jsonb[]，直接追加新事件即可
```

不引入 stores 表、不引入 user_roles。门店区分留 V2。

## 新增 Server Functions

```text
src/lib/mobile.functions.ts
  searchParcels({q})                     按单号/订单号/商品名糊查
  markParcelDelivered({id, photoUrl})    写状态 + 时间线
  markParcelProblem({id, note, photo})   异常标记
  sortItemToSku({parcelItemId, skuPatch})从子商品建/复用 SKU + 关联 label
  bindLabelEpc({labelId, epc})           扫 RFID 校验绑定
  photoSearch({imageBase64})             MVP A，调 Lovable AI Gateway
  ocrTrackingNo({imageBase64})           扫码失败时的 OCR fallback
```

入库与 SKU 写入沿用已有 `inv_apply_inbound_stock` + 直接 upsert，不重复造轮子。

## 技术细节

- PWA：仅 `public/manifest.webmanifest` + 2 张图标，`index.html` link 引入；不注册 SW
- 摄像头：`BarcodeDetector`（iOS Safari 16.4+）→ fallback `<input type="file" capture>` + AI OCR
- 蓝牙扫枪：在 `/m/scan` 和 `/m/inbound` 用隐藏 input 接管 keypress，回车提交
- 图片：统一走现有 `compressImage()`（1600px / webp 0.82）+ `toThumbUrl()` 显示
- AI：所有 AI 调用走 `recognize.functions`/新增 `mobile.functions` 模板（model: `google/gemini-3-flash-preview`，关键回退 `gemini-2.5-pro`）
- 路由：所有 `/m/*` 和 `/store/*` 文件路由用 TanStack flat 命名，不创建 `_app` 等保留前缀

## 交付顺序

1. **PWA 外壳 + /m 首页 + /m/parcels 搜索 + /m/receive 签收**（半天）
2. **/m/scan 通用扫码（条码/RFID/OCR）**（1 天）
3. **/m/sort 分拣台 + RFID 标签关联**（1.5 天，最复杂）
4. **/m/inbound 扫码入库手机版**（半天，复用 RPC）
5. **/m/photo-search**（1 天）
6. **/store 子站 MVP（首页 + 库存查询 + 单件溯源）**（半天）
7. **真机回归测试 + 二维码登录**（半天）

## 待你确认后再动手的两个细节

- **分拣台是否允许"批量按 N 件同 SKU 一次出 N 张标签"**？现有桌面流程支持，移动端要不要保留
- **RFID 蓝牙枪型号**？需要确认是否是 HID 键盘模式（多数支持）。若是 BLE 私有协议，会需要 Web Bluetooth API，复杂度+1

如果以上没问题，点 Approve 我就按交付顺序开干。
