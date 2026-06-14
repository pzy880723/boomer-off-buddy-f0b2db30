# Phase 2 实施计划

## 一、手持终端 API（核心新增）

所有接口放在 `src/routes/api/public/handheld/*`（公开前缀，绕过站点登录），**每个 handler 内部用 `X-Device-Token` 鉴权**（查 `inv_handheld_devices`，校验 token + active + 记录 `last_seen_at`）。返回统一 JSON：`{ ok, data?, error? }`。

### 1. 鉴权 & 设备
- `POST /api/public/handheld/auth/ping`
  入参：`X-Device-Token`
  返回：设备绑定的 `location_id / location_name / kind(warehouse|shop)`，用于 APP 启动时显示"当前登录到 XX 仓 / XX 门店"。

### 2. SKU 查询（APP 端 EPC→SKU 显示用）
- `GET /api/public/handheld/sku/by-epc?epc=xxx`
  返回 SKU 基本信息 + 状态（in_stock / unclaimed / sold / lost）+ 所属 location。
- `GET /api/public/handheld/sku/search?q=xxx`
  名称/编码模糊搜索，分页 20 条。

### 3. 入库扫描（仅 warehouse 设备可调用）
- `POST /api/public/handheld/inbound/scan`
  入参：`{ epcs: string[] }`（一次上报一批，去重幂等）
  逻辑：
  1. 校验设备 kind=warehouse
  2. 对每个 EPC 查 `inv_epcs`：
     - 已知 → 调 `inv_apply_movement(sku_id, device.location_id, +1, 'inbound', null, epc)`，更新 `inv_epcs.status='in_stock' / current_location_id`
     - 未知 → 写入 `inv_unclaimed_epcs`（status=pending, location_id=设备所在仓）
  3. 返回 `{ accepted: [...], unclaimed: [...], duplicated: [...] }`

### 4. 盘点扫描（warehouse + shop 都可用）
- `POST /api/public/handheld/stocktake/open`
  入参：`{ name?: string }`
  逻辑：在设备所在 location 创建 `stocktakes` 行，status=`scanning`，返回 `stocktake_id`。
  （同一 location 同一时间只允许一个 scanning 单，已有则直接返回该单）
- `POST /api/public/handheld/stocktake/scan`
  入参：`{ stocktake_id, epcs: string[] }`
  逻辑：批量写 `stocktake_scans`（unique on stocktake+epc 去重），未知 EPC 单独标记返回。
- `POST /api/public/handheld/stocktake/submit`
  入参：`{ stocktake_id }`
  逻辑：聚合 `stocktake_scans` → 写 `stocktake_lines`（按 sku 算 scanned_qty / expected_qty / diff），status 变 `submitted`，等待总部审核。

### 5. 调拨扫描（必须扫具体 EPC）
- `POST /api/public/handheld/transfer/ship-scan`
  入参：`{ transfer_id, epcs: string[] }`
  逻辑：校验设备 location = transfer.from_location_id 且 status=draft；写 `stock_transfer_epcs(side='ship')`。
- `POST /api/public/handheld/transfer/ship-confirm`
  入参：`{ transfer_id }`
  逻辑：核对每行 SKU 已扫数量 = 计划数量 → 对所有 epc 调 `inv_apply_movement(from, -1, 'transfer_ship', id, epc)`；status 变 `in_transit`。
- `POST /api/public/handheld/transfer/receive-scan`、`/receive-confirm`
  收货方设备扫描，写 `side='receive'`，确认时核对 ship/receive EPC 一致 → `inv_apply_movement(to, +1, 'transfer_receive', id, epc)`，更新 `inv_epcs.current_location_id`，status 变 `received`。

> 所有写操作走 service-role（在 handler 内 `await import('@/integrations/supabase/client.server')`），先做设备鉴权再调用。

## 二、后台 UI

### 新增页面
1. `/inventory/locations` — 库位列表（仓库 + 门店映射），只读 + 启停。
2. `/inventory/unclaimed` — 待认领 EPC 队列：列表 + 搜索 SKU 指派 + 一键认领（写入 `inv_epcs`，补一次 `inv_apply_movement` 入对应仓库）。
3. `/inventory/devices` — 手持终端管理：新建设备（生成随机 token，复制按钮）、绑定 location、停用。
4. `/inventory/stocktakes` 列表 + `/inventory/stocktakes/$id` 详情：
   - 显示差异行（多/少/未知 EPC）
   - 总部"审核通过"按钮 → 调 server fn `approveStocktake`：对每行差异调 `inv_apply_movement(location, diff, 'stocktake', id)`，status → `approved`；"驳回"→ `rejected`
5. `/inventory/transfers` 改造：
   - 列表带 4 状态筛选（draft/in_transit/received/cancelled）
   - 新建：选 from/to location + 行（SKU + 计划数量）→ 保存 draft
   - 详情：发出/收货扫描进度（实时显示已扫 EPC 数量 vs 计划），允许网页端"手动取消"

### 修改
- 侧边栏：移除"扫枪入库"入口；新增"库位 / 设备 / 待认领 / 盘点"。
- SKU 详情页：增加"分库位库存"小表（按 `inv_stocks` 列出每个 location 的数量）。
- 移除 `/inventory/inbound/new` 手动入库页面。

## 三、Server Functions（后台用）

新增：
- `src/lib/handheld-devices.functions.ts` — list/create/regenerate-token/deactivate
- `src/lib/stocktake.functions.ts` — listStocktakes / getStocktake / approveStocktake / rejectStocktake
- `src/lib/transfer-v2.functions.ts` — createTransfer / cancelTransfer / getTransfer（发出/收货由手持端 API 完成）
- `src/lib/unclaimed-epc.functions.ts` — list / claim(epc, sku_id) / discard
- `src/lib/locations.functions.ts` — list / toggleActive

全部用 `requireSupabaseAuth`，敏感操作（approveStocktake、claim）内部检查 `has_role(admin)`。

删除 `inventory.functions.ts` 中的 `submitInbound` / `createInboundOrder`。

## 四、不在本期内
- 手持端 APP 本身不动（用户已确认）
- 已售出/退货流转、Youzan 库存推送同步（后续单独迭代）
- 旧 mobile 扫枪 web 页面：保留代码但路由入口隐藏，提示"请使用手持终端"

---

**Phase 3 预告**：盘点审核通过后自动推 Youzan 库存差异；EPC 标签批次回填 `inv_epcs(status='unclaimed')` 以便手持端识别打印未入库的标签。

完成后会给你一份「手持端 APP 对接文档」（端点、请求/响应示例、错误码），交给 APP 开发者即可。
