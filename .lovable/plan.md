# 仓库商品 SKU 升级

## 1. 桌面端列表 `/inventory/skus`（`src/routes/inventory.skus.index.tsx`）

- 删除截图中的两条筛选 Tabs：类目 Tabs（全部/日本瓷器/…）和价格档 Tabs（全档/¥6.9/…）。
- 顶部保留：标题 + "扫枪入库" + "新建 SKU"。
- 搜索框（品名/EPC）保留，移到列表上方左侧。
- 卡片网格保持现在的样式，仅展示商品；类目/价格仍显示在卡片角标里，只是不再做筛选。
- 服务端 `listSkus` 不动（参数都是 optional，前端不再传 category/price_tier 即可）。

## 2. 新建 SKU 弹窗（`src/components/inventory/sku-form-dialog.tsx`）

新交互：

1. 选择 **类目**（保持现有下拉）。
2. **定价方式**单选：`标准价格档` / `自定义价格`。
   - 标准：弹出价格档（¥6.9 / 9.9 / 15.9 / 19.9 / 29.9 / 39.9 / 49.9）按钮组，点选即定价。
   - 自定义：显示数字输入框，自行填写（>0，最多两位小数）。
3. 品名、类型（单品/组包）、组包件数、单件重量、备注 —— 保持。
4. **图片**：把原来的 URL 文本框替换为真正的上传组件（拖拽/点击 + 复用 `src/lib/image-upload.ts` 的 `compressImage` + Supabase Storage 上传，参考 `item-image-uploader`），上传后回填 `image_url`。
5. 校验：类目 + 价格 + 品名必填；组包必填件数。

## 3. 自定义价对 EPC / 唯一约束的影响

- 现 EPC 形如 `INV-{类目码}-{价格×10 共3位}-{6位随机}`，自定义价（如 128 元）会突破 3 位。
- 调整 `generateEpc`：把价格段固定为 **5 位**（最多 ¥999.99），标准档照样能编码（如 0099）；老数据不受影响（只生成新 EPC 时使用新格式）。
- 同时新增一列 `is_custom_price boolean default false` 用于前端展示"自定义"标签和将来区分。
- 唯一约束 `(category, price_tier, name)` 在自定义价下依然有效（不同价格视为不同 SKU）。无需改动。

迁移内容：
- `ALTER TABLE inv_skus ADD COLUMN is_custom_price boolean NOT NULL DEFAULT false;`

## 4. 服务端 `createSku`（`src/lib/inventory.functions.ts`）

- `SkuInput` 增加 `is_custom_price: z.boolean().default(false)`。
- `price_tier` 校验从"正数"放宽到 `z.number().positive().max(99999.99)`；不再限定枚举。
- 入库逻辑不变（仍按 `price_tier` 算单价）。

## 5. 移动端 `/m/skus`（新增 `src/routes/m.skus.tsx` 及 detail）

- 在 `mobile-shell` 底部 Tab 增加"商品"入口（或在首页加入口卡片，二选一 — 默认加底部 Tab 第三个）。
- 列表样式按 `m.parcels` 卡片风格：单列，图片缩略 + 品名 + 类目 + 价格 + 库存 + EPC。
- 顶部固定"新建"按钮 → 打开 `Sheet`，复用与桌面相同的字段顺序（类目 → 标准/自定义价 → 品名 → 单品/组包 → 图片上传），调用同一个 `createSku` server fn。
- 图片上传走相机/相册（`<input type="file" accept="image/*" capture="environment">`），同样复用 `compressImage`。
- 搜索框（顶部，回车触发），无筛选 Tab。

## 技术细节

- 不动 `inventory.skus.$id.tsx`；如果用户进了详情页，自定义价格的展示沿用 `price_tier` 字段，加一个"自定义价"小徽章（基于新增的 `is_custom_price`）。
- 桌面/移动新建表单抽公共逻辑到 `useCreateSkuForm` hook（位于 `src/components/inventory/`），减少重复。
- 图片上传组件抽公共 `<SkuImageUploader>`，桌面/移动共用。

## 涉及文件

- 迁移：新增一条 SQL（加列）。
- 编辑：`src/routes/inventory.skus.index.tsx`、`src/components/inventory/sku-form-dialog.tsx`、`src/lib/inventory.functions.ts`、`src/lib/inventory.helpers.ts`（EPC 生成）、`src/components/mobile/mobile-shell.tsx`（底部 Tab）。
- 新增：`src/routes/m.skus.tsx`、`src/components/inventory/sku-image-uploader.tsx`、`src/components/inventory/use-create-sku-form.ts`。

确认后我会执行迁移并实现。
