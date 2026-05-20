## 结论先说

**不需要做"批量重压老图"**这种麻烦事。Supabase Storage 自带 `render/image/public/...?width=...&quality=...` 转换接口，对**已经在桶里的原图**也立即生效，第一次访问后会被 CDN 缓存。

项目里已经有 `src/lib/image.ts → toThumbUrl()` 这个工具，只是**大部分展示位还在直接用原图 URL**，所以才慢。把这些点全部走 `toThumbUrl` 就行——老数据立刻提速，不动数据库、不动 Storage。

## 当前漏网的地方（全部 `<img src={item_image_url}>` 直连原图）

| 文件 | 行 | 显示尺寸 | 建议 thumbWidth |
|---|---|---|---|
| `components/japan-parcel/item-image-uploader.tsx` | 199 | 112×112 / 64×64 预览 | 256 |
| `components/japan-parcel/item-card-dialog.tsx` | 97 | 弹窗大图 | 800 |
| `components/japan-parcel/parcel-card-dialog.tsx` | 185 | 卡片中等图 | 400 |
| `components/japan-parcel/parcel-edit-panel.tsx` | 248 | 编辑面板小图 | 200 |
| `components/japan-parcel/pack-price-calculator-dialog.tsx` | 185 | 拆包对话框中图 | 400 |
| `components/japan-parcel/items-hover-preview.tsx` | 57 | hover 网格 200px | 已封装 `ClickableThumb`，无需动 |
| `routes/purchase.japan-parcel.index.tsx` | 550 | 列表小图 | 128 |

已经正确走 `toThumbUrl` 的：`image-lightbox.tsx`、`items-hover-preview.tsx` 封面那张。

## 改动方案（只动展示层，不动数据/上传链路）

### 1. 统一展示走 `toThumbUrl`

把上表 7 个 `<img src={item_image_url} ...>` 改成：

```tsx
<img
  src={toThumbUrl(item_image_url, <对应宽度>) ?? item_image_url}
  loading="lazy"
  decoding="async"
  ...
/>
```

对大图弹窗类（item-card-dialog、parcel-card-dialog）可以直接换成 `ClickableThumb`——缩略图走 webp，点开后再加载原图，体验最自然。

### 2. AI 调用也用缩略图（关键）

`pack-price-calculator-dialog.tsx` 把 `item.item_image_url`（原图 URL）传给后端 `recognize.functions`。AI 视觉模型对 1024px 以内的图识别效果已经饱和，传原图浪费一次"服务端 fetch 5MB"的耗时。

改成传 `toThumbUrl(item.item_image_url, 1024) ?? item.item_image_url` 即可，服务端代码、prompt、模型全部不动。

### 3. 不做的事

- **不**做 Storage 批量迁移脚本——Supabase 转换接口已经覆盖老图。
- **不**改 `item-image-uploader.tsx` 上传逻辑（上一轮刚加的客户端压缩继续生效，新图就直接是 webp 小图）。
- **不**改数据库字段、不改 RLS、不改 bucket。
- **不**碰 `screenshot-dropzone.tsx`（那是识别面板，base64 直接给 AI，跟商品图无关）。

## 预期效果

- 列表 / 卡片 / 弹窗里**老数据**的图片从 3-8MB 原图变成 20-150KB webp，**首屏快 10-30 倍**，第二次因 CDN 命中接近瞬开。
- AI 拆包识别的服务端时延也会下降一截（少一次大文件 fetch）。
- 用户无感知，URL 形态、点击放大、保存、编辑全部不变。

## 验证

打开 `/purchase/japan-parcel`：
1. DevTools → Network → Img，应该看到请求 URL 形如 `…/storage/v1/render/image/public/parcel-item-images/…?width=128&quality=70`，响应类型 `image/webp`，大小几十 KB。
2. 点开任意包裹卡片大图、拆包对话框，图片同样走 render/image。
3. 老的、上一轮压缩前上传的大 PNG 也立刻变快。
