## 问题定位

`src/components/japan-parcel/item-image-uploader.tsx` 的 `uploadFile()` 把**原图原样**丢给 Supabase Storage：

```ts
await supabase.storage.from(BUCKET).upload(path, file, { ... })
```

而新建包裹场景下的图片来源几乎都是：
- **截图粘贴**：浏览器把剪贴板里的截图序列化成 PNG，一张 1920 宽的网页截图通常 **3–8 MB**
- **拍的商品照 / 网页另存图**：手机/相机原图 **3–10 MB**

而商品卡片里实际只展示 112×112 / 64×64 的缩略图，详情页最大也就几百像素。**上传的体积比实际需要大了 30–100 倍**，这就是"超级超级慢"的根因——上传时间 ≈ 文件大小 / 上行带宽，国内到 Supabase 上行 200–500 KB/s 是常态，一张 5 MB PNG 要 10–25 秒。

辅证：
- 上传限制写的是 8 MB（说明确实在传原图）
- 没有任何 `canvas` / `createImageBitmap` / `toBlob` 的压缩代码
- 上传桶是 `parcel-item-images`，是公共桶，不存在权限慢的问题

## 解决方案

在 `uploadFile()` 之前加一步**客户端压缩 + 缩放**：

```text
原图 File ──► <canvas> 缩放到 max 1600px 长边
            ──► canvas.toBlob('image/webp', 0.82)
            ──► 上传压缩后的 Blob（通常 80–250 KB）
```

预期效果：5 MB PNG 截图 → 约 120 KB webp，**上传时间从 10 秒降到 < 1 秒**，显示效果在卡片缩略图尺寸下肉眼无差别。

### 具体改动（只动一个文件）

`src/components/japan-parcel/item-image-uploader.tsx`：

1. 新增 `compressImage(file, { maxDim = 1600, quality = 0.82 })` 工具函数：
   - 用 `createImageBitmap(file)` 解码（比 `Image` + `onload` 快且不阻塞主线程）
   - 计算等比缩放后的目标尺寸（长边 ≤ 1600，原图更小则不放大）
   - 画到 `OffscreenCanvas`（不支持时回退到普通 `<canvas>`）
   - `convertToBlob({ type: 'image/webp', quality: 0.82 })`
   - GIF / 已经很小（< 200 KB）/ 非位图（SVG 之类）→ **跳过压缩直接传**，避免把动图压成静态、把矢量栅格化
   - 失败兜底：压缩抛错就用原 File 上传

2. `handleFile()` 里把当前的体积上限放宽到 **20 MB**（原图，压完后实际上传很小），并在 `uploadFile()` 前先调 `compressImage`。

3. 上传后用户能直接看到缩略图 → 体验上几乎是"秒传"。

### 不动的部分

- 上传链路（Supabase Storage 直传）保持不变，不引入 edge function
- bucket、RLS、URL 形态都不变，老数据兼容
- `src/components/screenshot-dropzone.tsx`（识别面板用的，那个本来就走 base64 给 AI，不走 Storage）暂不动；如果你也觉得它慢，可以再加一轮，但识别那条路径本身就要把图传给 AI，压不压差别小。

## 技术细节

- WebP 在所有现代浏览器（Chrome/Edge/Safari 14+/Firefox）都支持 `canvas.toBlob('image/webp')`；万一返回 null（极旧浏览器）回退到 `image/jpeg` 质量 0.85。
- `OffscreenCanvas.convertToBlob` 在 Safari 16.4+ 才稳定，所以做特性检测 + `<canvas>.toBlob` 兜底。
- 文件名扩展名按压缩后的实际 MIME 来取（`.webp` / `.jpg`），不要用原文件名后缀。
- 不引新依赖，纯浏览器 API。

## 验证方式

部署后到 `/purchase/japan-parcel/new`：
1. 截一张满屏网页图，`Ctrl+V` 粘贴到某个商品图位 → 应该 1 秒内显示缩略图。
2. 打开 DevTools → Network → 看 `parcel-item-images` 那次 PUT 请求的 Request 大小，应该在 50–300 KB 区间。
3. 老的已上传图片 URL 不受影响。
