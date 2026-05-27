## 目标

手机端 `/m/parcels` 商品列表点开的"商品详情" Sheet（`ItemDetailSheet`）目前只展示信息，桌面端已有的"拆包单价计算"（AI 标题+图片识别 → 回填 pack_pieces / pack_unit_note）在手机端无法触达。本次给手机端补齐同款功能。

## 改动范围

仅前端 / UI，复用现有的 `PackPriceCalculatorDialog` 与 server fn（`estimatePiecesFromTitle` / `estimatePiecesFromImage` / `updateParcelItem`），不动数据库与业务逻辑。

### 1) `src/components/mobile/item-detail-sheet.tsx`
- 扩展 `ItemDetailValue` 类型，补 `pack_pieces / pack_pieces_source / pack_unit_note` 三个可选字段（与后端字段一致）。
- 顶部信息卡下新增一块「拆包单价」卡片：
  - 若已有 `pack_pieces`：显示 `拆 N{unit} · ¥X.XX/{unit}`（用 `computePiecePrice(item_total_jpy, item_total_cny, pack_pieces)` 计算），右侧放一个「重新计算」按钮。
  - 若未拆包：显示一行说明 + 主按钮「✨ 拆包单价计算」。
- 点击按钮 `setCalcOpen(true)` 打开 `PackPriceCalculatorDialog`，传：
  - `item={ id, item_title, item_title_cn, item_image_url, item_total_jpy, pack_pieces, pack_pieces_source, pack_unit_note }`
  - `landedCny={ item.item_total_cny ?? null }`（手机端列表没有按重量摊运费的整包 landed，直接用子订单 `item_total_cny` 作为到手价基准，与列表里 `computePiecePrice` 的口径保持一致）。
- 保存后 `PackPriceCalculatorDialog` 已自动 invalidate `jp-parcel*`；额外 invalidate `["mobile-parcel"]`（在 `onOpenChange(false)` 回调里调用 `qc.invalidateQueries`），让列表立刻刷新。

### 2) `src/routes/m.parcels.tsx`
- 当前 `setSelected(it as ItemDetailValue)` 已经把整条记录塞进 sheet，确认 `searchParcels` 返回的 item 行里包含 `pack_pieces / pack_pieces_source / pack_unit_note` 三字段；若缺失则在 `src/lib/mobile.functions.ts` 的 select 列表里补上（仅 select 字段，不动 schema）。

### 3) 不动的部分
- `PackPriceCalculatorDialog` 自身（Dialog 在手机端弹出已经能正常使用，`max-w-md` 移动端宽度可接受，无需改写成 Sheet）。
- `pack-pieces.functions.ts` / `japan-parcel.functions.ts` / 数据库 / RLS / 桌面端 UI。

## 验收

1. 手机端打开 `/m/parcels`，点任一商品 → Sheet 内能看到「拆包单价计算」入口。
2. 已有拆包数据的商品，Sheet 内直接展示单件单价 + 「重新计算」按钮。
3. 点击按钮 → 弹出对话框 → 自动跑标题识别 → 可手动改件数 → 保存 → Sheet/列表上的"拆 N{unit} · ¥X.XX"立即更新。
