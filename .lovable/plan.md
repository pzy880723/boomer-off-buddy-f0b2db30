## 问题

「拆包单价计算」对话框里 `包内件数` 和 `单件单位` 两个输入框上下不对齐：

- 左边 label `包内件数` 用了 `flex items-center gap-1` + `<Hand>` 图标，高度被图标撑高
- 右边 label `单件单位` 是纯文字，高度更小
- 结果两个 Label 高度不一致 → 下方的 Input 不在同一水平线

## 方案

只改 `src/components/japan-parcel/pack-price-calculator-dialog.tsx` 中那一段 grid：

给两个 Label 统一高度（`flex h-5 items-center gap-1`），并在「单件单位」label 前加一个等宽透明占位（`h-3 w-3` 不可见），让两个 label 行高完全一致，输入框自然对齐。

不动其它任何样式 / 逻辑。