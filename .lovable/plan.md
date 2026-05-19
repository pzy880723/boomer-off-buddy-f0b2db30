## 国内大宗采购模块

### 1. 数据库新表

**`domestic_bulk_orders`**（订单主表）
- 基础：`supplier_name`、`supplier_contact`、`source_order_no`、`purchased_at`、`total_cny`、`status`（5 档同国内小包）
- 物流：`carrier`、`tracking_no`、`shipping_cny`、`receiver_name`、`receiver_phone`、`receiver_address`、`delivered_at`
- 票据/合同：`invoice_no`、`contract_no`、`pay_method`、`attachment_urls jsonb`（截图/PDF 链接数组）
- 备注：`notes`、`completeness`、`raw_payload`、`deleted_at`、标准时间戳
- RLS 沿用现有 open_* 模式

**`domestic_bulk_order_lines`**（明细行）
- `order_id uuid`（外键到 domestic_bulk_orders）、`position`、`item_title`、`qty`、`unit_price_cny`、`subtotal_cny`、`notes`
- 创建主表时同时落 N 行；编辑时整体 replace

**Storage bucket**：`domestic-bulk-attachments`（public，存合同/发票/付款截图）

状态枚举复用 `domestic_orders` 的 5 档字符串（pending_pay/paid/shipped/delivered/completed），不建新枚举。

### 2. 路由与文件

```text
src/routes/purchase.domestic-bulk.tsx              # Outlet 壳
src/routes/purchase.domestic-bulk.index.tsx        # 列表 + 筛选 + 统计卡
src/routes/purchase.domestic-bulk.new.tsx          # 新建表单（含明细行 + 附件上传）
src/routes/purchase.domestic-bulk.$id.tsx          # 详情/编辑/状态切换/删除
src/lib/domestic-bulk.functions.ts                 # CRUD serverFn（list/get/create/update/setStatus/remove）
```

列表页参考 `purchase.domestic.index.tsx`：状态/供应商搜索、统计卡（总单数/本月金额/累计金额）、DataTable。

新建/编辑页：
- 顶部供应商 + 订单号 + 采购时间 + 状态
- 中部明细行表格（添加行/删除行，自动求和填回 total_cny）
- 物流分区 + 票据/合同分区
- 附件区域：复用 `parcel-item-images` 风格的 dropzone，上传到 `domestic-bulk-attachments`

### 3. 侧边栏

`src/components/app-sidebar.tsx` 在「采购物流」组的「国内小包」之后加：
- `{ title: "国内大宗", url: "/purchase/domestic-bulk", icon: PackageCheck }`

`NavTo` 联合类型 + `__root.tsx` 面包屑映射同步追加。

### 4. 仪表盘

`src/lib/dashboard.functions.ts`：
- 新增 channel key `domestic_bulk`，按 `domestic_bulk_orders.purchased_at` + `total_cny` 桶进月/年/累计 + 12 月趋势
- 与现有 `japan_parcel` / `japan_bulk` / `domestic` 并列返回

`src/routes/dashboard.tsx`：
- `CHANNEL_META` 增加 `domestic_bulk`（图标、单位「单」、链接 `/purchase/domestic-bulk`）
- 渲染从 3 卡变 4 卡（响应式 grid 改为 `sm:grid-cols-2 xl:grid-cols-4`）
- 12 月趋势 BarChart 增加 `domestic_bulk` 系列

### 5. 不在范围内

- 不做 AI 截图识别（仅手工录入）
- 不做 Excel 导入（后续按需）
- 不挂库存批次/SKU 关联（第一版独立）
- `japan_bulk` 依旧是 placeholder，本次不动

### 6. 实现顺序

1. 申请 migration 创建两张表 + storage bucket + RLS
2. 写 serverFn + 路由 + 表单组件
3. 改侧边栏 + 面包屑
4. 改 dashboard.functions + dashboard.tsx 渲染 4 卡
5. 保存 memory（`mem://features/domestic-bulk-orders.md`）
