## 结论

不需要再改代码。

拆包单价的计算链路是：

```
intl_total_jpy + items[].weight_g
        │
        ▼
computeParcelItemLanded()  ──►  landed.landedCny  (每件商品到手价)
        │
        ▼
computePiecePrice(item_total_jpy, landedCny, pack_pieces)
        │
        ▼
pieceCny = landedCny / pack_pieces
```

上一轮的两个修复（select 补 `weight_g` + 金额兜底）已经让 `landedCny` 正确。三处用到 `pieceCny` 的地方都通过同一个 `landed.landedCny` 拿值，所以**会自动同步刷新**：

- `src/routes/purchase.japan-parcel.index.tsx` 第 576 行（列表商品行的"拆 N 个 · RMB x.xx/个"小标签）
- `src/components/japan-parcel/item-card-dialog.tsx` 第 76 行（商品弹窗的拆包单价）
- `src/components/japan-parcel/pack-price-calculator-dialog.tsx` 第 142 行（拆包计算器弹窗）

## 如果你看到的数字还是旧的

是浏览器/React Query 缓存。请刷新一次 `/purchase/japan-parcel`（Ctrl/Cmd + R）。然后切到"商品视角"对比 8713g vs 240g 那两件，二者的"均摊运费"和"拆 N 个 · 单价"都应该按重量比例变化。

如果刷新之后某条数据仍然不对，请贴一下具体的包裹截图，我再排查是不是某些 item `weight_g` 在库里是 NULL（那种情况下会按金额比例兜底，可能与你的直觉不同）。
