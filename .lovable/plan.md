## 目标

小包裹相关界面里的商品图：
- 列表/编辑面板里只加载 **缩略图**（小尺寸、低带宽）
- 点击放大弹窗后才加载 **原图**
- AI 拆包件数识别（`estimatePiecesFromImage`）继续用 **原图** 提交，保证识别精度

## 现状

- 图片都存在 Supabase Storage 的 `parcel-item-images` bucket，URL 形如  
  `…/storage/v1/object/public/parcel-item-images/items/xxx.png`
- 所有展示都走 `ClickableThumb`，目前缩略图和大图都直接用原图 URL（`<img src={原图} className="h-16 w-16">`），浏览器实际仍下载全尺寸文件，浪费带宽
- AI 识别端 `estimatePiecesFromImage` 已经拿的就是 `item_image_url` 原图，**无需改动**

## 方案

利用 Supabase Storage 自带的图片转换接口：  
把 `/object/public/` 替换为 `/render/image/public/`，加 `?width=&quality=&resize=contain`，即可拿到服务端生成的缩略图（webp，自动缓存）。非 Supabase URL（极少数手填的）回退使用原 URL。

### 1. 新增 `src/lib/image.ts`

```ts
export function toThumbUrl(url: string | null, width = 256): string | null {
  if (!url) return url;
  // 只处理本项目 Supabase Storage 的 public 链接
  if (url.includes("/storage/v1/object/public/")) {
    const transformed = url.replace(
      "/storage/v1/object/public/",
      "/storage/v1/render/image/public/",
    );
    const sep = transformed.includes("?") ? "&" : "?";
    return `${transformed}${sep}width=${width}&quality=70&resize=contain`;
  }
  return url;
}
```

### 2. 修改 `ClickableThumb`

- 新增 `thumbWidth?: number`（默认 `256`）
- 缩略图 `<img>` 的 src 用 `toThumbUrl(src, thumbWidth)`
- 弹窗里的大图保持 `src`（原图）
- 弹窗 `<img>` 加 `loading="eager"`，让大图在弹窗打开时才请求

### 3. 调用点按显示尺寸传 `thumbWidth`

预估出现位置和合适宽度（按 devicePixelRatio≈2 取展示尺寸的 2 倍）：

| 文件 | 当前展示尺寸 | thumbWidth |
| --- | --- | --- |
| `routes/purchase.japan-parcel.index.tsx` 列表行 | h-12/h-16 | `160` |
| `components/japan-parcel/items-hover-preview.tsx` 封面/缩略 | h-10–h-16 | `200` |
| `components/japan-parcel/parcel-edit-panel.tsx` 编辑卡片 | 较大 | `320` |
| `components/japan-parcel/parcel-card-dialog.tsx` 弹窗内列表 | h-16 | `200` |
| `components/japan-parcel/pack-price-calculator-dialog.tsx` 商品概览 | h-16 | `200` |
| `routes/purchase.japan-parcel.import.tsx` 导入预览 | h-16 | `200` |

所有调用点替换为 `<ClickableThumb src={…} thumbWidth={…} … />`，不改原本的 `className` 控制的视觉尺寸。

### 4. AI 识别保持原图

`estimatePiecesFromImage` 入参直接传 `item.item_image_url`（原图 URL），不变。  
`pack-price-calculator-dialog.tsx` 第 118 行的调用本身就是 `image_url: item.item_image_url`，确认无需修改。

## 不在本次范围

- 不修改任何后端 / Storage 配置
- 不动 `extension/`、meruki 抓取链路
- 不动数据库或字段

## 风险 & 兜底

- Supabase 图片转换需要项目启用 image transformations。Lovable Cloud 项目默认开启；若 render endpoint 返回 400，浏览器只会缩略图加载失败，原图弹窗仍正常。可在第一次部署后用 DevTools 看一眼网络面板的 `render/image/public/...` 是否 200。如果不可用，把 `toThumbUrl` 改为直接返回原 URL 即可一键回退。

## 验证

1. 打开 `/purchase/japan-parcel` 列表，DevTools Network 看 `render/image/public/...?width=160` 请求返回 webp、体积明显小于原 PNG
2. 点击缩略图，弹窗加载原 `…/object/public/…png`，清晰可见
3. 在某个商品上点"AI 拆包件数计算"，确认仍能识别成功（说明 AI 用的还是原图）
