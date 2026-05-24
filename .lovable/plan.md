## 目标

在 SKU 商品图选择处（`SkuImagePicker`），除了"本地上传"外，再支持：
1. **AI 生成** — 用品名 + 类目 + 可选自定义描述，让 Gemini Nano Banana 生成商品图
2. **在线搜索** — 调用 Firecrawl 搜索网络图片，让用户从结果里挑一张

最终都把图存进 `parcel-item-images/skus/` 桶，写回 `state.imageUrl`，与现有上传逻辑完全一致，下游零改动。

## 用户交互

`SkuImagePicker` 顶部 dropdown「+ 添加图片」展开 3 个选项：
- 上传图片（保留现状）
- AI 生成
- 在线搜索

### AI 生成弹窗
- 默认 prompt = `${类目中文} ${品名} 商品白底图 高清` （可编辑）
- 「生成」按钮 → 调用 serverFn `generateSkuImage`（Lovable AI / `google/gemini-2.5-flash-image`）
- 生成结果（1 张，base64）预览 → 「使用此图」上传到桶并回填，或「重新生成」

### 在线搜索弹窗
- 搜索框默认填 `品名`，可改
- 「搜索」→ 调用 serverFn `searchSkuImages`（Firecrawl `search` + `imageLinks`，取前 12 张缩略图 URL）
- 网格展示，点击某张 → 服务端下载 → 上传到桶 → 回填 URL（避免热链失效 + 跨域）

## 技术实现

### 1. serverFn: `src/lib/inventory.functions.ts`（或新建 `src/lib/sku-image.functions.ts`）

```ts
generateSkuImage({ prompt }) -> { dataUrl: string }
// 调 https://ai.gateway.lovable.dev/v1/chat/completions
// model: google/gemini-2.5-flash-image, modalities:["image","text"]
// 返回 data:image/png;base64,...

searchSkuImages({ query }) -> { images: { url, thumb, source }[] }
// 调 Firecrawl v2 search，imageLinks: 8
// 过滤掉无 https 链接的项

saveImageFromUrl({ url }) -> { imageUrl: string }
// 服务端 fetch 该 URL（或 dataUrl）→ 上传到 parcel-item-images/skus/
// 用 supabaseAdmin，返回公共 URL
```

需要的密钥：
- `LOVABLE_API_KEY` ✅ 已配置
- `FIRECRAWL_API_KEY` — 需要让用户在 Connectors 里启用 Firecrawl 连接器；若用户暂不想接，"在线搜索"按钮就 disable 并提示

### 2. 新组件 `src/components/inventory/sku-image-source-dialog.tsx`

承载两种新模式，内部用 Tabs：AI / 搜索。接收 `defaultName`、`defaultCategoryLabel`，回调 `onPick(url)`.

### 3. 改造 `src/components/inventory/sku-image-picker.tsx`

- 空态按钮改为 `DropdownMenu`，3 个 item
- 选 "上传" → 走原 `<input type=file>`
- 选 "AI 生成" / "在线搜索" → 打开 `SkuImageSourceDialog`
- 把当前所在表单的 `name` / `category` 透传进来（在 `SkuMetaFields` 里把这俩透传给 picker）

### 4. `sku-meta-fields.tsx`

把 `state.name` / `state.category` 作为 `defaultName` / `defaultCategory` 传给 `SkuImagePicker`。仅 props 透传，无其他逻辑改动。

## 不在范围内

- 不改数据库 schema
- 不改 SKU 创建/列表逻辑
- 不改移动端 `sku-image-picker` 之外的代码（手机端自动继承）
- 不做多图、不做编辑已上传图（如需后续再加）

## 涉及文件

- 新增：`src/lib/sku-image.functions.ts`、`src/components/inventory/sku-image-source-dialog.tsx`
- 修改：`src/components/inventory/sku-image-picker.tsx`、`src/components/inventory/sku-meta-fields.tsx`

## 需确认

1. **在线搜索**走 Firecrawl 可以吗？如果还没启用 Firecrawl 连接器，我会在实现里先把"在线搜索"按钮 disable+提示，AI 生成单独可用；或者你也可以现在就接 Firecrawl 后我一起接。
2. AI 生成默认 1 张就够，还是出 4 张让你挑？（出 4 张耗时/费用 ×4）
