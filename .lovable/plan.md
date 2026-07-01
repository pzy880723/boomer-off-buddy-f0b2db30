## 目标

1. 图片改成正方形 + 加载提速
2. RFID 标签默认打印 1 张
3. PC/手机所有「扫枪入库」文案改为「RFID 入库」

## 1. AI 图片强制正方形

修改点：
- `src/server/handheld-ai.server.ts` `SYSTEM_LISTING_IMAGE`：在 prompt 里明确要求 **1:1 正方形，居中裁切，白底/浅灰底**；调用 `google/gemini-3.1-flash-image` 时传 `size: "1024x1024"`（gateway 支持透传）。
- `src/lib/sku-image.functions.ts` `generateSkuImage`（`google/gemini-2.5-flash-image`）：prompt 追加「正方形 1:1」硬约束，保存前用轻量校验（服务端不再二次裁），主要靠 prompt。
- APP 传上来经 `ai.prepare-listing-image` 处理的图，输出即为 1024×1024。

## 2. 加载提速

问题：自定义商品卡片直接用 Supabase 原图（几 MB），首屏一次性拉取几十张。

修改：
- 复用现有 `src/lib/image.ts` 的 `toThumbUrl(url, w)`（走 `/storage/v1/render/image/public/` 缩略）。
- `src/components/inventory/product-card.tsx`：
  - `StandardProductCard` / `SingleSkuCard` 卡片主图：`toThumbUrl(cover, 480)` + `loading="lazy"` + `decoding="async"` + `width/height` 属性防抖。
  - `StandardProductRow` / `SingleSkuRow` 列表行 48×48 缩略：`toThumbUrl(cover, 96)`。
- `src/components/inventory/sku-image-gallery.tsx`：
  - 主图 `toThumbUrl(cur, 720)`，`loading="lazy"`（非首屏时）。
  - 缩略图 `toThumbUrl(src, 128)`。
  - Lightbox 用原图。
- `src/routes/api/public/handheld/items.sign-read-url.ts` + `products` / `products.lookup` / `sku.search` 里 batch sign：给返回的 `read_url` 追加一个 `thumb_url`（宽 480，签名 URL 直接把 `/object/sign/` 换成 `/render/image/sign/` 并追加 `width=480&quality=75`），APP 也能受益。若签名桶 render 不受支持则仅在 UI 端处理，不改 API。（先只改前端，API 层加 `thumb_url` 属可选增量。）

先做前端 4 处 + 画廊，即可显著提速；不改数据结构。

## 3. 打印张数默认 1

- `src/routes/inventory.skus.$id.tsx` L47：`useState("10")` → `useState("1")`
- `src/routes/m.skus.$id.tsx` L57：同上

## 4. 文案：「扫枪入库」→「RFID 入库」

替换以下文件的字符串（仅 UI 文案，不改路由/接口）：
- `src/routes/inventory.inbound.new.tsx`（页面标题 + meta title）
- `src/routes/inventory.inbound.index.tsx`（描述 + 新建按钮 + 空态）
- `src/routes/inventory.skus.index.tsx`（顶部入口按钮）
- `src/routes/inventory.products.$code.tsx`（入口按钮）
- `src/routes/inventory.skus.$id.tsx`（提示文字）
- `src/routes/m.skus.$id.tsx`（提示文字）
- `src/routes/m.index.tsx`（快捷入口描述）
- `src/routes/__root.tsx` 面包屑映射 `inbound: "扫枪入库"` → `"RFID 入库"`
- 说明新增副标题：「支持 RFID 手持机 / RFID 台面读写器 / RFID 扫描门」

`src/routes/m.scan.tsx`「蓝牙扫枪」这类字面表达仍是设备名，保留不动。

## 技术说明

- Supabase render endpoint 仅对 public 桶有效；本仓库 SKU 主图桶 `parcel-item-images` 是 public，`toThumbUrl` 直接可用。sku-listing 是私桶，APP 侧走签名 URL，本轮不改。
- gemini image 模型对 `size`/`aspect_ratio` 参数支持不稳定，主要靠 prompt「正方形 1:1、居中裁切」强约束；若模型仍返非正方，前端 `object-cover` 已能兜住视觉。
