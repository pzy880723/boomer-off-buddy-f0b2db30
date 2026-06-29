# 让 APP 拍的图在 ERP 商品里永久显示

## 现状
- APP 调 `items/smart-create` 时没有传任何图片字段，导致 `inv_skus.image_url = null`。
- 现有 schema 只支持 1 张图，且字段名是 `image_url`（外链/signed URL）。signed URL 7 天过期，写进库也会失效。
- `sku-listing` / `sku-raw` 是私有桶。

## 目标
APP 上传 → 服务端把 storage_path 永久保存到 SKU → ERP（PC + 移动端）按需签 URL 显示，主图大图 + 缩略图横排 + Lightbox。

## 后端改动

### 1. 数据库迁移
- `inv_skus` 新增 `image_paths text[] not null default '{}'`，存形如 `sku-listing/2026-06-29/<device>/<uuid>.jpg` 的相对路径（含 bucket 前缀），第 0 个为主图。
- 一次性回填：把现有非空 `image_url`（外链 http 直接放进去，signed URL 跳过）转成长度 1 的数组备用，方便统一前端。

### 2. Handheld API
- `SmartCreateReq` 新增 `image_storage_paths: { bucket: 'sku-raw'|'sku-listing', storage_path: string }[]`（最多 6 张）；保留 `image_url` 字段做向后兼容。
- `items/smart-create` 写入逻辑：把 `image_storage_paths` 规范成 `${bucket}/${storage_path}` 存到 `image_paths`；若同时有 `image_url` 外链且数组为空，则把外链放数组第 0 位。复用已存在 SKU 时，新图追加到尾部去重。
- `items/$id` 返回新字段 `images: { storage_path, read_url }[]`（read_url 7 天 signed URL，外链直接返回原 URL）。`image_url` 字段保留指向主图 read_url，方便老 APP。
- OpenAPI 与 `docs/handheld-api.md` 同步更新。

### 3. ERP 端取图
- 新增 server fn `getSkuSignedImages(skuId)` → 解析 `image_paths`，对私有 bucket 路径用 `supabaseAdmin.storage.createSignedUrls`（24 小时），http 外链原样返回。
- 新增 server fn `listSignedCoverUrls(skuIds[])` 给列表批量签封面图。

## 前端改动

### PC 端
- `src/routes/inventory.skus.$id.tsx`：把现在的方块封面换成"主图（点开 Lightbox）+ 下方缩略图横排"。复用 `ImageLightbox`（已存在于 japan-parcel 模块）。
- SKU 详情新增"添加/重排图片"按钮：复用 `sku-image-picker` 流程，但写入 `image_paths`（保持向后兼容，可同时仍写 `image_url`）。
- 列表 `inventory.skus.index.tsx`、`inventory.products.tsx`：封面取 `image_paths[0]` 的 signed URL，没有则回落 `image_url`。

### 移动端
- `src/routes/m.skus.$id.tsx` / `m.products.$code.tsx` / `m.skus.index.tsx` / `m.parcels.tsx`：同样取签名后的主图，并在详情页加横向缩略图条 + 全屏预览。

## 给 Codex 的指令（同步会附在实施完成后的回复里）
APP 端需要调整：
1. 拍照后走 `items/upload-image`（拿 storage_path）→ 直接 PUT 上传 → **不再调 `sign-read-url`**，直接把 `{ bucket, storage_path }` 攒到本地数组。
2. `items/smart-create` 请求体改为传 `image_storage_paths: [{bucket, storage_path}, ...]`，最多 6 张，第 0 张是主图。
3. SKU 详情页解析 `images: [{storage_path, read_url}]`，用 `read_url` 渲染图集；不再消费 `image_url`。

## 验证
- 用 APP 拍 3 张图新建 → 查 `inv_skus.image_paths` 长度为 3 → ERP `/inventory/skus/{id}` 主图 + 2 张缩略图都能显示 → Lightbox 可切换 → 24h 后刷新仍然能签出新 URL。
