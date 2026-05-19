## 真正的 Bug

不是算法错。`computeParcelItemLanded` 一直就是按 `weight_g` 比例分摊的（2.5kg / 25kg × 1000 = 100，正确）。

问题在 `src/lib/japan-parcel.functions.ts` **第 107 行的 list 查询**里 `japan_parcel_items(...)` 子选择**漏掉了 `weight_g`**：

```
japan_parcel_items(id, item_title, ..., quantity, ..., freight_diff_jpy, pack_pieces, ...)
                                                                          ↑ 没有 weight_g
```

结果：列表组件拿到的每个 item 都是 `weight_g === undefined` → `itemWeightWeight()` 兜底用 `quantity`（全是 1）→ 看起来就是"按件数等分"。

## 改动

**唯一一处文件 + 单行 select 字符串**：
`src/lib/japan-parcel.functions.ts:107` —— 在 `japan_parcel_items(...)` 列表里加上 `weight_g`。

```diff
- japan_parcel_items(id, item_title, item_title_cn, item_image_url, item_total_jpy, item_total_cny, unit_price_jpy, quantity, sub_order_no, position, tariff_category, tariff_rate, freight_diff_jpy, pack_pieces, pack_pieces_source, pack_unit_note)
+ japan_parcel_items(id, item_title, item_title_cn, item_image_url, item_total_jpy, item_total_cny, unit_price_jpy, quantity, weight_g, sub_order_no, position, tariff_category, tariff_rate, freight_diff_jpy, pack_pieces, pack_pieces_source, pack_unit_note)
```

## 顺手做的小事

- 在 `computeParcelItemLanded` 加一条兜底：所有 item 都缺 `weight_g` 时改为**按金额比例**分摊（你刚才选的方案），金额也都为 0 时再退回均摊。单件缺失继续用 quantity 兜底（保持现状）。

## 不动

- DB schema、RLS、UI 组件、其它 serverFn 都不动。
- 详情页 `parcel-edit-panel` 自己取 weight_g 已经正常，不受影响。

## 验证

刷新 `/purchase/japan-parcel`，"商品视角"打开，看 8713g 那件的"均摊运费"应该明显比 240g 那件大约 36 倍。
