## 现象定位

自定义商品的封面图存在私桶 `sku-listing`（AI 修图输出 1024×1024 PNG，动辄 800KB+）。当前流程：

1. `signSkuCovers` 用 service role 生成 24h **原图** 签名 URL（`/storage/v1/object/sign/...`）。
2. 前端 `toThumbUrl` 只替换 `/object/public/` → `/render/image/public/`，**遇到签名 URL 直接原样返回**，走的还是原图。
3. 于是 PC/移动端商品卡、列表行、详情弹窗都在拉整张 1024 PNG，慢是必然的。

标准商品能秒开是因为它们大多用外链或公共桶，正好命中 `toThumbUrl` 的替换分支。

## 优化方案（只动展示层，不改数据）

### 1. `src/lib/image.ts` — 扩展 `toThumbUrl`

新增对签名 URL 的处理：

- `/storage/v1/object/sign/<bucket>/<path>?token=...` → `/storage/v1/render/image/sign/<bucket>/<path>?token=...&width=<w>&quality=70&resize=contain&format=origin`
- 保留原有 public URL 分支。
- 未识别时才原样返回。

Supabase 签名 transform 端点复用同一 token，无需重签，一行 URL 改写即可拿到 webp 缩略图。

### 2. `src/lib/sku-image-resolver.server.ts` — 保持源图签 URL，不动。

前端统一通过 `toThumbUrl` 按用途选宽度（列表 96 / 卡片 480 / 详情主图 720），Supabase render 会自动出 webp，大图秒变几十 KB。

### 3. AI 出图存储优化 `src/server/handheld-ai.server.ts` + `ai.prepare-listing-image.ts`

- 上传时把 AI 返回的 PNG 走 `.webp` 后缀 + `content-type: image/webp`（Gemini 已返回 1024 方图，无需再压）。若 mime 是 png 就存成 `.png`，但显式加 `cacheControl: '31536000, immutable'`，缩略图端点带上强缓存。
- 目的：让 render/image 转换命中缓存后二次加载几乎零延迟。

### 4. 覆盖到所有使用点

确认以下位置都走 `toThumbUrl` 后自动受益（无需再改）：

- `src/components/inventory/product-card.tsx`（4 处，已在用）
- `src/components/inventory/sku-image-gallery.tsx`（主图 720 / 缩略 128）
- `src/components/mobile/item-detail-sheet.tsx`、`src/routes/m.skus.index.tsx`、`src/routes/m.products.$code.tsx` — 逐个复核并替换裸 `<img src={cover}>` 为 `toThumbUrl(cover, N)`。

### 5. 首屏 LCP 小优化

商品网格首行的 `SingleSkuCard` / `StandardProductCard` 传入 `priority` 时改用 `loading="eager"` + `fetchpriority="high"`；其余保持 lazy。范围仅 `inventory/skus` 首屏前 6 张、移动端 `m/skus` 前 4 张。

## 预期效果

- 自定义商品列表/卡片单图从 ~800KB PNG 降到 ~20-40KB webp（宽度按需 96/480/720），首屏总下载量下降 90%+。
- 二次访问命中 Supabase render CDN 缓存，几乎瞬开。
- 无需迁移历史数据，也不影响 APP / 有赞同步。

## 技术细节

```ts
// src/lib/image.ts
export function toThumbUrl(url: string | null | undefined, width = 256): string | null {
  if (!url) return url ?? null;
  const swap = (from: string, to: string) => {
    if (!url.includes(from)) return null;
    const t = url.replace(from, to);
    const sep = t.includes("?") ? "&" : "?";
    return `${t}${sep}width=${width}&quality=70&resize=contain`;
  };
  return (
    swap("/storage/v1/object/public/", "/storage/v1/render/image/public/") ??
    swap("/storage/v1/object/sign/",   "/storage/v1/render/image/sign/") ??
    url
  );
}
```

不改数据库、不改 API、不改路由，属于纯展示层优化。
