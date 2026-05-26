## 目标

修复 `/m/parcels` 在「按商品」模式下的三个问题：
1. 点击商品行应弹出**商品卡**（ItemDetailSheet），而不是跳转到包裹详情页
2. 列表中显示**单件平均成本（CNY）** = `item_total_cny / quantity`（含分摊后的真实到手成本）
3. 搜索框只走商品维度，不再保留「按包裹」搜索分支
4. 整体 UI 重新设计，去掉当前略显粗糙的卡片样式

## 范围

仅改动手机端，不动 PC 端，不动数据库。

### 文件改动

**1. `src/lib/mobile.functions.ts` — `searchParcels`**
- 商品模式 select 增加 `service_fee_jpy, domestic_freight_jpy, freight_diff_jpy, exchange_rate, weight_g, pay_method, sub_order_no, merchant_order_no, source_platform, condition, addon_service, tariff_category, tariff_rate, notes, arrival_photo_urls`，让前端能直接喂给 `ItemDetailSheet`，无需二次请求。
- 包裹模式有搜索词时直接返回空，或在前端层屏蔽（见下）。保留 `mode === "parcel"` 分支用于无搜索词的浏览。

**2. `src/routes/m.parcels.tsx` — 重写**

交互：
- 搜索框聚焦或输入任何字符时，强制 `mode = "item"` 并禁用「按包裹/按商品」切换条（或直接隐藏切换条，仅在搜索为空时显示）。
- 商品行 `onClick` 不再使用 `<Link>`，改为 `setSelectedItem(it)` 打开 `ItemDetailSheet`。需要把 serverFn 返回的字段映射成 `ItemDetailValue`。
- 包裹行依旧 `<Link to="/m/receive/$id">`。

UI 重新设计（移动端友好）：
- **顶部搜索栏**：圆角输入框去掉边框，改为 `bg-muted/60` + 内嵌 Search 图标 + 清除按钮（有内容时显示 ×）。sticky 时加 `backdrop-blur` + 底部细分隔。
- **段控件**：用单一 `Tabs`（待签收 / 已签收）替换现在的两段按钮组，靠左小尺寸；视图模式切换器（按包裹/按商品）改为右上角小型 segmented control（图标 + 文字），仅在搜索为空时出现。
- **商品卡片行**：
  - 左侧 64×64 圆角缩略图（无图时显示包裹 emoji 占位）
  - 右侧两行：第一行商品名（粗体，line-clamp-2）；第二行小字 = 子单号 · 包裹单号
  - 右上角金额块：大字 `¥{单件平均成本}`（CNY，2 位小数），下面小字 `× {qty} 件`
  - 异常用左侧 2px 红色竖条 + 角落小红点替代当前的 AlertTriangle，更克制
  - 已签收行底部追加灰色小字「签收 MM-DD HH:mm」
  - 行间距 `py-3.5`，分隔用 `border-b border-border/40` 而非纯 divide
- **空状态**：用 `EmptyState` 组件（项目已存在）+ 文案区分搜索 / 待签 / 已签
- **加载**：用 3-5 行 skeleton 行（圆角占位）替换闪烁

**3. （可选）`src/components/mobile/item-detail-sheet.tsx`**
- 若打开时缺字段会渲染空，则补一个 fallback；预计不需要改，因为 serverFn 已经把字段补齐。

## 验证

- `/m/parcels` 搜索 "ガンプラ"：自动隐藏切换条、只显示商品列表
- 点击商品行：底部弹出 `ItemDetailSheet`，金额、税率、到货照片可查可改
- 商品行金额显示为「单件平均成本」=`item_total_cny/quantity`，与点开后明细里的 `单价` 概念区分清楚（明细里仍展示原始 `unit_price_jpy`）
- 「按包裹」模式下点击仍跳 `/m/receive/$id`
- 异常包裹的视觉提示更克制，不再抢眼
