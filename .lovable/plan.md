## 目标

把 `/m/parcels` 改成「**待签收 / 已签收**」分页的工作清单，并升级 `/m/receive/$id`：子商品可点开看详情、签收时拍多张到货照片（最多 9 张），支持「拍照」和「相册选择」两种来源。

---

## 1. 包裹列表 `/m/parcels`

顶部 segmented tabs：
- **待签收**（默认）— `status ∈ {purchased, at_jp_warehouse, shipping_intl}`，按 `created_at desc`
- **已签收** — `status ∈ {delivered, completed}`，按 `received_at desc`

下方保留搜索框（在当前 tab 内过滤）。

每张卡片显示：
- 左：商品缩略图（80×80）
- 右上：**单号**（tracking_no 或 source_order_no）
- 右中：商品中文名（fallback 日文名）
- 右下一行：**¥价格**（grand_total_cny）· **采购时间**（intl_pay_at，缺则 created_at，格式 MM-DD）
- 已签收 tab 多显示一行小字「签收于 MM-DD HH:mm」

点击卡片 → `/m/receive/$id`。

## 2. 签收页 `/m/receive/$id`

### 2.1 子商品可点开
现在子商品只是只读列表。改成：
- 每行右侧加 `›` 箭头，整行可点
- 点击 → 从底部弹出 `ItemDetailSheet`（基于 shadcn `Sheet side="bottom"`）
- Sheet 内容复用 `parcel-card-dialog` 里 `OverviewItems` 的字段排版：大图 + 名称 + 单价/数量/重量/汇率/手续费/国内运费/补差/关税/支付方式/支付时间/商户单号/平台/成色/备注。新建 `src/components/mobile/item-detail-sheet.tsx`，单条 item 版本。

### 2.2 到货照片（最多 9 张）
- 标题从「外包装照片」改为「**到货照片（最多 9 张，至少 1 张）**」
- 改成 3×3 九宫格：已上传的格子显示缩略图 + 右上角 × 删除；下一格显示「+」按钮
- 点「+」弹出底部 action sheet 两个选项：
  - **拍照**（隐藏 input，`accept="image/*" capture="environment"`，单张）
  - **从相册选择**（隐藏 input，`accept="image/*" multiple`，可一次选多张，自动截到剩余配额）
- 上传走现有 `uploadParcelImage(file, "receive", id)`，并发上传 + 单张失败不阻塞其它
- 状态：`photoUrls: string[]`，达到 9 张时隐藏「+」格

### 2.3 签收提交
- 签收按钮 disabled 条件改为 `photoUrls.length === 0`
- 调用 `markParcelDelivered({ data: { id, photo_urls: photoUrls } })`
- 异常提交同步支持 `photo_urls`

## 3. 后端 `src/lib/mobile.functions.ts`

### `searchParcels`
- 入参加 `bucket: "pending" | "received"`（可选；不传等同当前行为）
- select 增加 `intl_pay_at`
- 根据 bucket 设 `.in("status", ...)`；`received` 按 `received_at desc`，`pending` 维持 `created_at desc`

### `markParcelDelivered` / `markParcelProblem`
- 入参 `photo_url` 旁新增 `photo_urls: z.array(z.string().url()).max(9).optional()`
- 写 timeline 时存 `photo_urls`（数组），兼容保留 `photo_url`（=数组首张）
- 不改库表结构（`status_timeline` 是 jsonb，直接装）

## 4. 数据库

无需 migration。所有照片以 URL 数组形式装进现有 `japan_parcels.status_timeline` jsonb。

---

## 涉及文件

```
新增  src/components/mobile/item-detail-sheet.tsx
改动  src/routes/m.parcels.tsx          # tabs + 卡片字段
改动  src/routes/m.receive.$id.tsx      # 多照片 + 子商品点击
改动  src/lib/mobile.functions.ts       # searchParcels bucket、签收支持 photo_urls
```

## 非目标（本次不做）

- 不改 SKU / 分拣相关流程
- 不做拍照模式下"连拍多张"（capture 标签浏览器侧实现各异，先用相册多选兜底）
- 不做照片裁剪/标注
