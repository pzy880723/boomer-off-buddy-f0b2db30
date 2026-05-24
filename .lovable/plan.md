
## 目标
1. 列表默认列表模式 + 隐藏顶部"商品 SKU"大标题区
2. 商品/SKU 支持「编辑」「删除」
3. 商品详情页按电商详情排版重新设计（图小、信息右排、模块化分块）

---

## 1. 列表页 (`src/routes/inventory.skus.index.tsx`)

- `useState<ViewMode>("list")` 默认 list
- 删除 `<PageHeader title="商品 SKU" ... />` 整块（即截图红框区）
- 把右上角的「扫枪入库」和「新建商品」按钮移到 Tabs 那一行的右侧（与搜索/视图切换并列），避免功能丢失
- 列表行（`StandardProductRow` / `SingleSkuRow`）右侧追加行内"⋯"菜单：
  - 标准商品：编辑（改品名/图片/编码/重量/备注）/ 删除（删除该商品下全部价格档 SKU）
  - 自定义、组包：编辑 / 删除
- 大图卡（`StandardProductCard` / `SingleSkuCard`）右上角浮一个"⋯"按钮

---

## 2. 编辑 / 删除

### 后端 `src/lib/inventory.functions.ts`

- 扩展 `updateSku` 的 patch 允许字段：`name / sku_code / image_url / notes / weight_g / status / price_tier`（自定义、组包可改价；标准档不允许改 price_tier）
- 新增 `updateStandardProduct({ key, patch })`：按当前 key（sku_code 或 category|name）批量改这一组所有子 SKU 的共用字段（name/sku_code/image_url/notes/weight_g）
- 新增 `deleteSku({ id })`：
  - 若 `stock_qty > 0` 或存在 `inv_inbound_lines` → 报错，提示先清空库存或归档
  - 否则一并删除 `inv_label_batches` 后删除 SKU
- 新增 `deleteStandardProduct({ key })`：对该组内每条 SKU 执行同样的安全删除

### 前端组件

- 新增 `src/components/inventory/sku-edit-dialog.tsx`：单 SKU 编辑（自定义/组包：可改价；标准价格档：只读价、只改备注）
- 新增 `src/components/inventory/product-edit-dialog.tsx`：标准商品组级编辑（品名/编码/图/重量/备注）
- 删除走 `AlertDialog` 二次确认
- 编辑/删除成功后 `queryClient.invalidateQueries({ queryKey: ["inv-skus"] })`

---

## 3. 商品详情页重新排版（电商详情风格）

### `src/routes/inventory.products.$code.tsx`（标准商品）

布局参考京东/天猫商品详情：

```
[← 返回 SKU 列表]                                [编辑] [删除] [扫枪入库]

┌─────────────────────────────────────────────────────────┐
│ ┌────────┐  品名（大）                                   │
│ │        │  类目 · 标准商品 · N 个价格档                 │
│ │ 240px  │                                              │
│ │ 主图   │  ¥6.90 起   总库存 128 件                    │
│ │        │  编码 SKU-JP-...   单重 120g                  │
│ └────────┘  ─────────────────────────────                │
│             [快速操作: 扫枪入库 / 打印标签 / 编辑]        │
└─────────────────────────────────────────────────────────┘

┌──── Tabs: 价格档 | 备注 ────┐
│ 价格档子 SKU 表格 ...        │
└──────────────────────────────┘
```

- 主图尺寸 `h-60 w-60`（小屏 `h-40 w-40`），不再撑满左列 280×280
- 删 `<PageHeader>`，标题改为右侧 `h1` + 描述行
- 信息列网格化：价格起、库存、编码、单重，2 列 metric 风格
- 价格档子 SKU 列表保留并改为更"产品规格表"的样式，每行带"打印 / 入库"快捷链接
- 备注若有，作为独立 Card 放在 Tabs 内或主图下方
- 顶部 actions 加入编辑、删除按钮

### `src/routes/inventory.skus.$id.tsx`（自定义/组包详情）

同样收紧：

```
[← 返回]                                  [编辑] [删除]
┌─────────────────────────────────────────────────┐
│ [图 200px]  品名 (h1)                            │
│             类目 · 自定义/组包 · 含 N 子项        │
│             ¥XX.XX   库存 X 件                   │
│             EPC mono · 编码 mono                 │
└─────────────────────────────────────────────────┘

Tabs: 子项(仅组包) | RFID 打印 | 打印记录 | 入库历史
```

- 当前已是 flex 布局，进一步拆成 Tabs，避免一屏挤 4 张 Card
- 主图固定 `h-40 w-40`（移动）/ `h-48 w-48`（桌面）

---

## 技术细节

- 删除前置校验都在 serverFn 内完成，前端只展示错误 toast
- `groupStandardSkus` key 已是 `sku_code || category|name`，`updateStandardProduct` / `deleteStandardProduct` 用同样规则筛选记录
- 视图模式可写入 `localStorage("inv-skus-view")` 让用户刷新后保留选择
- 所有新增/修改的颜色继续走 semantic token（primary/muted/destructive 等）

---

## 文件清单

新增
- `src/components/inventory/sku-edit-dialog.tsx`
- `src/components/inventory/product-edit-dialog.tsx`
- `src/components/inventory/row-actions-menu.tsx`（统一的 ⋯ 菜单 + 删除确认）

修改
- `src/lib/inventory.functions.ts` — 扩展 updateSku、新增 updateStandardProduct / deleteSku / deleteStandardProduct
- `src/routes/inventory.skus.index.tsx` — 默认 list、删 PageHeader、按钮搬位、接入操作菜单
- `src/components/inventory/product-card.tsx` — 卡片 / 行追加 ⋯ 按钮
- `src/routes/inventory.products.$code.tsx` — 电商风格重排版 + 编辑/删除入口
- `src/routes/inventory.skus.$id.tsx` — 电商风格 + Tabs 分块 + 编辑/删除入口
