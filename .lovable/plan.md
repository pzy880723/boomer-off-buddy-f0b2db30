
## 重构目标

把现有 mock 数据驱动的 `/inventory/products`、`/inventory/batches`、`/inventory/transfers` 三页，换成符合中古杂货场景的真实库存模块：SKU 共用 EPC、价格档分类、RFID 标签先打印后扫枪盘点入库。第一版不挂采购批次。

---

## 1. 数据模型（新建 3 张表）

### `inv_skus` — 商品档案
一行 = 一种共用 EPC 的商品。

核心字段：
- `category` enum：日本瓷器 / 欧洲瓷器 / 中古玩具 / 二次元周边 / 音像制品 / 数码家电 / 珠宝首饰 / 时尚配件 / 日用杂货 / 古美术
- `price_tier` numeric：6.9 / 9.9 / 15.9 / 19.9 / 29.9 / 39.9 / 49.9（前端枚举，后台可扩展）
- `name` text：品名（如"奥特曼软胶"）
- `kind` enum：`single`（单品）/ `pack`（组包，加盟商批量拿货用）
- `pack_pieces` int：组包内含件数（single 时为 null）
- `epc` text unique：RFID EPC，打印标签时落库；同 SKU 所有标签共用同一 EPC
- `weight_g` numeric：单件重量（pack 是整包重量）
- `image_url` text：商品图
- `stock_qty` int：当前库存件数（由入库/出库累加，先做单仓口径）
- `notes` text、`status` enum（active/archived）

唯一约束：`(category, price_tier, name)` 或显式 SKU 编码（按答复 1 选 SKU 命名=类目+档+品名，三元组天然唯一）。

### `inv_label_batches` — RFID 标签打印批
一行 = 一次"打印 N 张同 SKU 标签"的任务。

字段：`sku_id`、`qty`（打印份数）、`printed_at`、`operator`、`status`（printed/scanned_in/cancelled）、`notes`。

用途：先打印 = 系统已知"未来会有 N 件 SKU-X 进来"，对账时能查漏。

### `inv_inbound_orders` + `inv_inbound_lines` — 入库单
扫枪一次提交 = 一张入库单。

`inv_inbound_orders`：`id`、`source`（jp_parcel / jp_bulk / domestic / manual，可空，第一版不强绑）、`scanned_at`、`operator`、`total_qty`、`total_value_cny`（按 SKU 价格档汇总）、`notes`。

`inv_inbound_lines`：`order_id`、`sku_id`、`qty`、`unit_price`、`subtotal`。一张单按 SKU 聚合 N 行。

全部 RLS 开放（与现有 japan_parcels 一致）。

---

## 2. 流程设计

```text
1. SKU 档案页 (/inventory/skus)
   ├─ 按 类目 / 价格档 双 tab 过滤
   ├─ 新建 SKU：选类目 → 选价格档 → 填品名 → 选 single/pack(+pack_pieces) → 拍/传图 → 保存
   └─ 系统自动生成 EPC（uuid 或 13 位编码）

2. RFID 标签打印 (/inventory/labels 或 SKU 详情内嵌)
   ├─ 选 SKU + 输入打印份数 → 调"打印"按钮
   ├─ 后端创建 label_batch 记录
   └─ 前端调起浏览器打印 / 走打印机（第一版先生成可打印的标签 PDF/HTML 预览）

3. 扫枪入库 (/inventory/inbound/new) — 手机端为主
   ├─ 大按钮"开始扫码"，光标常驻输入框
   ├─ 扫枪持续把 EPC 当键盘输入推送，前端按回车分隔接收
   ├─ 实时聚合：按 EPC → SKU → 件数累加，显示"已扫 47 件 / RMB 612.3"
   ├─ 未识别 EPC 高亮警告
   └─ "完成入库" → 落 inbound_order + lines + 累加 sku.stock_qty
```

扫枪二次开发后可直接 POST 一组 EPC 到 `/api/public/inbound`（第一版先不做，预留路由）。

---

## 3. 路由 / 页面变更

新增：
- `/inventory/skus`（列表+新建对话框，替代旧 products 页）
- `/inventory/skus/$id`（详情：基本信息、打印记录、入库历史、库存曲线）
- `/inventory/inbound`（入库单列表）
- `/inventory/inbound/new`（手机优先的扫枪页）

保留/暂搁：
- `/inventory/batches`、`/inventory/transfers` 第一版保留入口但加"v2 重构中"占位，不做改动
- 旧 `inventory/products` 路由 301 到 `/inventory/skus`

侧边栏「商品库存」改成：商品 SKU / 标签打印 / 扫枪入库 / 入库记录。

---

## 4. 共享常量

`src/lib/inventory.helpers.ts`（新增）：
- `INV_CATEGORIES`（10 个类目枚举 + label）
- `PRICE_TIERS = [6.9, 9.9, 15.9, 19.9, 29.9, 39.9, 49.9]`（先写常量，后台维护放到 v2）
- `SKU_KIND_LABEL`
- `formatEpc()`、`generateEpc()`、`aggregateScans(epcList)`

---

## 5. ServerFn（创建 `src/lib/inventory.functions.ts`）

- `listSkus({ category?, price_tier?, search?, page })`
- `upsertSku(input)`
- `createLabelBatch({ sku_id, qty })`
- `lookupSkusByEpcs(epcs[])` — 扫枪页轮询/批量查
- `submitInbound({ scans: [{ epc, qty }], notes? })` — 事务：写 order + lines + 更新 sku.stock_qty
- `listInboundOrders`、`getInboundOrder($id)`

---

## 6. 实施顺序

1. 建表迁移（3 张表 + RLS）
2. `inventory.helpers.ts` 常量 + EPC 生成
3. `inventory.functions.ts` 全部 serverFn
4. `/inventory/skus` 列表 + 新建/编辑
5. SKU 详情页内嵌"打印标签"组件（先输出可打印 HTML）
6. `/inventory/inbound/new` 扫枪页（手机端为主，输入框聚焦+回车聚合）
7. `/inventory/inbound` 列表 + 详情
8. 侧边栏调整 + 旧 products 路由重定向
9. 更新 `mem://index.md` 记录新模块约定

---

## 技术细节

- 扫枪输入：用 `<input>` 隐藏聚焦 + `onKeyDown` 监听 Enter，缓存 EPC 到本地 `scans` Map，节流刷新汇总。
- EPC 生成：`INV-{category 2字母}-{tier*10}-{6位 base36}`，方便人眼识别。
- 库存累加用 Postgres 函数 `update_sku_stock(sku_id, delta)` 保证并发安全。
- 标签打印：第一版用 `window.print()` + 专用 CSS（A4 标签纸 N 列），后续接打印机 SDK。
- 手机视口：扫枪页强制 `set_preview_device_viewport=mobile` 提示开发。

