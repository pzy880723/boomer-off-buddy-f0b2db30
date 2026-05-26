## 原因
你看的"拆 50 个 · RMB 17.14/个"是桌面页 `/purchase/japan-parcel` 用 `pack_pieces` + `computePiecePrice` 渲染的徽标。手机端 `/m/parcels` 商品视图的 `searchParcels` 根本没 select `pack_pieces / pack_pieces_source / pack_unit_note`,所以没法显示。

## 改动(2 个文件)

### 1) `src/lib/mobile.functions.ts` — item 模式 SELECT 加 3 字段
- `japan_parcel_items.select(...)` 字符串末尾追加 `, pack_pieces, pack_pieces_source, pack_unit_note`
- 返回对象里透传:`pack_pieces`、`pack_pieces_source`、`pack_unit_note`

### 2) `src/routes/m.parcels.tsx` — 商品行加单件成本徽标
- import `computePiecePrice` from `@/lib/japan-parcel.helpers`
- 在商品 `<li>` 现有"¥avgCny × qty 件"右上角金额块下方,若 `pack_pieces > 1`:
  - `{ pieceCny } = computePiecePrice(item_total_jpy, item_total_cny, pack_pieces)`
  - 渲染一行小徽标:`拆 {n}{unit} · RMB {pieceCny.toFixed(2)}/{unit}`,样式参考桌面页(`bg-pink-50 text-pink-600` 之类小 pill)。`unit = pack_unit_note || "个"`
  - 若仅 `pieceJpy` 可用则降级显示 `JPY xxx/个`
- 包裹视图(parcel mode)不动,因为是聚合行,没有按行的 pack_pieces

## 不动
- 桌面端 `/purchase/japan-parcel` 渲染逻辑、`pack-price-calculator-dialog`、数据库均不变
