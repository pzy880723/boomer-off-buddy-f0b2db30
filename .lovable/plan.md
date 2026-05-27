## 问题

在手机端 `/m/parcels` 商品详情抽屉里点"拆包单价计算"，对话框里点保存后：

- `PackPriceCalculatorDialog` 调 `updateParcelItem` 写库成功，toast 显示"已保存"。
- 但它只 invalidate `["jp-parcels"] / ["jp-parcels-counts"] / ["jp-parcel"]`（桌面端的 key），手机端用的是 `["mobile-parcels", ...]`，刷不到。
- 抽屉里展示的 `item` 来自父组件 `selected` 这个本地 state，对象引用没变；即便后台 query 重新拉到了新数据，`selected` 也不会自动更新。
- 结果：拆包卡片还是显示"拆包单价计算"按钮，看起来"没保存"，其实库里已经写进去了，重新打开抽屉才会看到。

## 方案

只改前端展示，不动业务逻辑/数据库。

### 1) `src/components/japan-parcel/pack-price-calculator-dialog.tsx`

- 新增可选 prop `onSaved?: (v: { pack_pieces: number | null; pack_pieces_source: string | null; pack_unit_note: string | null }) => void`。
- 在 `handleSave` 成功 toast 之后、`onOpenChange(false)` 之前调用 `onSaved?.(...)`，把刚刚写库的三个字段值回传给调用方。
- 桌面端调用方不传 `onSaved`，行为不变。

### 2) `src/components/mobile/item-detail-sheet.tsx`

- 用本地 state 覆盖三个 pack 字段：`const [packOverride, setPackOverride] = useState<{ pieces, source, unit } | null>(null)`，并在 `useEffect([item?.id])` 里重置为 `null`。
- 渲染拆包卡片和传给 `PackPriceCalculatorDialog` 的 `item` 时，优先使用 `packOverride` 里的值，回落到 `item.*`。
- 把 `onSaved` 传给 `PackPriceCalculatorDialog`，回调里 `setPackOverride(...)`，这样卡片立刻显示新的 `拆 N 个 · ¥X/个` 和"重新计算"按钮。
- 同时把 `onOpenChange(false)` 时的 invalidate key 改成（或追加）`["mobile-parcels"]`，让列表/汇总也刷新；保留对 `["mobile-parcel"]` 的兼容调用即可。

### 3) 不动的部分

- `PackPriceCalculatorDialog` 的识别管线、`updateParcelItem`、`pack-pieces.functions.ts`、数据库、RLS、桌面端调用处。
- `m.parcels.tsx` 不需要改（重开抽屉时父级 query 已刷新，新 `selected` 自然带新值；本次会话内的即时显示靠 sheet 内 override 完成）。

## 验收

- 打开手机端 `/m/parcels` → 任一商品 → 拆包单价计算 → 填件数 → 保存。
- 对话框关闭后，拆包卡片立刻显示 `拆 N 个 · ¥X.XX/个` 和"重新计算"按钮，不需要重开抽屉。
- 再次打开同一商品，数据保持一致（说明真的写库了）。
