## 目标

针对手机端「自定义商品」的 3 个问题做适配优化：

1. 手机端列表点进 SKU 详情，目前跳到 PC 版页面（`/inventory/skus/$id`），需要做手机版详情。
2. 新建 SKU 后默认库存显示「1」，需要确认为 0（新建商品默认无库存）。
3. 智能新建里的拍照/上传流程：拍完/上传完应该自动识别，识别不满意可重新拍/重新选，新数据覆盖旧数据。

---

## 1. 手机端 SKU 详情页

新建路由 `src/routes/m.skus.$id.tsx`，用 `MobileShell` 包裹，复用现有 `getSku` / `createLabelBatch` / `deleteSku` server functions，但 UI 重做为手机布局：

- 顶部 MobileShell，返回到 `/m/skus`，右上放「编辑 / 删除」icon button
- 主信息卡：商品图（满宽，aspect 4:3）+ 品名 + 类目/Kind/评级 badge + 大字号价格 + 库存
- 信息行：EPC（长按可复制）、商品编码、重量、状态
- Tabs（移动友好的横向滚动）：RFID 打印 / 打印记录 / 入库历史 /（如组包）子项 /（如有备注）备注
- RFID 打印面板：数字 stepper + 「打印并记录」按钮（仍走 `window.print()`，预览 div 复用现有 `PrintLabels`）
- 打印记录、入库历史用纵向卡片列表替代 DataTable（手机不适合表格）
- 编辑入口：手机端的编辑用底部 Sheet 包一层 `SkuEditDialog` 的字段（先按现有 dialog 显示，后续可再优化）

在 `src/routes/m.skus.tsx` 的 `MSingleRow` 把 `<Link to="/inventory/skus/$id">` 改成 `to="/m/skus/$id"`。标准商品组 `MStandardRow` 暂保持不变（标准商品手机版详情不在本次范围）。

技术细节：
- 路由文件命名遵循 `m.skus.$id.tsx` 扁平点号约定
- 公共展示逻辑（PrintLabels、属性行）可从 `inventory.skus.$id.tsx` 抽到 `src/components/inventory/sku-detail-shared.tsx` 让两端共用，避免重复

---

## 2. 默认库存

数据库里 `inv_skus.stock_qty` 默认就是 0，`createCustomSku` 也没有写入库存。需要确认用户看到的「1」是不是来自之前测试时的入库记录。

排查步骤：
- 在手机端列表 `MSingleRow` 上检查 `row.stock_qty` 实际值；如果创建即为 1，可能是某次手动加过或者别的入口

修复方案（双保险）：
- 在新写的手机端 SKU 详情顶部把库存渲染保持 `sku.stock_qty`（如实显示），不做加 1
- 在创建 SKU 的 server fn 里显式 `stock_qty: 0`，避免未来任何 default 漂移

如果用户实际是看到 PC 详情页里 RFID 打印数量 input 默认值 10，那只是打印数量不是库存——这种情况无需改库存逻辑，仅做手机版详情即可。

> 这块在切到手机版详情后会自然解决；如果还有问题，请截图一下「显示 1 的位置」我再定位。

---

## 3. 智能新建：自动识别 + 重拍覆盖

修改 `src/components/inventory/smart-sku-capture.tsx`：

- **自动识别**：移除「识别填充」按钮。每当 `shots` 数组变化（拍完一张 / 上传完一张 / 删除一张）且数量 ≥ 1 时，自动触发 `handleAnalyze`（用 useEffect + 防抖 600ms，避免连拍时多次调用）。
- **重拍覆盖**：识别完成后保留照片缩略图，新增「重新开始」按钮（清空 shots + 重置已填字段的标记），用户重拍后会自动重新识别并覆盖之前 `onApply` 出去的字段。
- **覆盖逻辑**：在父组件 `MNewCustomSkuSheet` 里记录「上次智能识别填入的字段集合」，再次识别时先把这些字段清空再 apply 新结果，避免残留旧值（比如旧的 description）。
- **进行中态**：识别中显示 loading 蒙层在视频/缩略图区域，按钮文案不变。
- **关闭按钮**：识别成功不再自动 `onClose()`，让用户能预览结果、不满意就重拍；改为提供「完成」按钮收起拍摄面板。

---

## 涉及文件

新增：
- `src/routes/m.skus.$id.tsx`
- `src/components/inventory/sku-detail-shared.tsx`（抽出 PrintLabels）

修改：
- `src/routes/m.skus.tsx`（详情链接指向 /m/skus/$id）
- `src/routes/inventory.skus.$id.tsx`（复用 sku-detail-shared）
- `src/components/inventory/smart-sku-capture.tsx`（自动识别 + 重拍覆盖）
- `src/lib/inventory.functions.ts`（createCustomSku 显式 stock_qty: 0，保险）

不动：标准商品 / 组包商品的桌面对话框、PC 端 SKU 详情主结构。
