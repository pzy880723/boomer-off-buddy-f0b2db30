# 手持终端 RFID API 对接文档

所有接口都在 **`/api/public/handheld/*`** 前缀下（绕过站点登录）。
鉴权方式：每个请求必须带 HTTP Header

```
X-Device-Token: <设备的 token>
```

Token 由后台 **仓库管理 → 手持终端** 页面创建/复制。设备绑定的库位决定上报的目标位置。

统一响应：
```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": "...", "...": "..." }
```

Base URL（生产）：`https://boomer-off-buddy.lovable.app`
Base URL（预览）：`https://project--2158bffa-7f82-4bc6-9df9-c59319d262f7-dev.lovable.app`

---

## 1. 设备心跳 / 登录信息

`POST /api/public/handheld/auth/ping`

Response data:
```json
{
  "id": "uuid",
  "device_code": "HH-001",
  "label": "总仓 1 号机",
  "location_id": "uuid",
  "location_kind": "warehouse",
  "location_name": "总仓"
}
```

APP 启动时调用一次；用 `location_kind / location_name` 显示"当前登录到 XX 仓 / XX 店"。

---

## 2. SKU 查询

`GET /api/public/handheld/sku/by-epc?epc=xxxx`
- `known: true` → 返回 `epc / status / sku / location`
- `known: false` → 返回 `unclaimed`（如果在待认领队列里）

`GET /api/public/handheld/sku/search?q=关键字`
返回 `{ items: [...] }`，最多 20 条，匹配 sku_code / name。

---

## 3. 入库（仅 warehouse 设备）

`POST /api/public/handheld/inbound/scan`
```json
{ "epcs": ["E20012345...", "E20098765..."] }
```
Response data:
```json
{
  "accepted_count": 8,
  "duplicated_count": 1,
  "unclaimed_count": 2,
  "accepted":   [{ "epc": "...", "sku_id": "..." }],
  "duplicated": [{ "epc": "...", "reason": "already_in_stock | sold | ..." }],
  "unclaimed":  ["E20...", "..."]
}
```
- `accepted` 已写入设备绑定的仓库库存（+1 / 件）。
- `unclaimed` 自动进入「待认领 EPC」队列，由总部在后台手动指派 SKU。
- 一次最多 500 个 EPC。

---

## 4. 盘点（仓库 & 门店都可）

### 4.1 打开盘点单
`POST /api/public/handheld/stocktake/open`
```json
{ "name": "可选备注" }
```
Response data:
```json
{ "id": "uuid", "code": "ST-...", "status": "scanning", "reused": false }
```
同一库位同时只能有一个 `scanning` 单；如果已有会直接返回（`reused: true`）。

### 4.2 上传扫描
`POST /api/public/handheld/stocktake/scan`
```json
{ "stocktake_id": "uuid", "epcs": ["E20..."] }
```
可多次调用，按 (stocktake_id, epc) 去重，未识别 EPC 会单独返回。

### 4.3 提交盘点
`POST /api/public/handheld/stocktake/submit`
```json
{ "stocktake_id": "uuid" }
```
聚合所有扫描 → 生成差异行 → 状态变 `submitted`，等待总部审核。审核通过后总部会调用 `inv_apply_movement` 自动修正库存。

---

## 5. 调拨（必须扫具体 EPC）

调拨单在后台先建好（status=`draft`），手持端只负责扫码与确认。

### 5.1 发出方扫描（设备 location = transfer.from_location）
`POST /api/public/handheld/transfer/ship-scan`
```json
{ "transfer_id": "uuid", "epcs": ["..."] }
```

### 5.2 发出方确认（清点合规后调用一次）
`POST /api/public/handheld/transfer/ship-confirm`
```json
{ "transfer_id": "uuid" }
```
- 校验每个 SKU 已扫数量 = 计划数量，否则 422，body 含 `issues`。
- 成功后扣减发货方库存，EPC 状态变 `in_transit`，调拨单变 `in_transit`。

### 5.3 收货方扫描（设备 location = transfer.to_location）
`POST /api/public/handheld/transfer/receive-scan`
```json
{ "transfer_id": "uuid", "epcs": ["..."] }
```

### 5.4 收货方确认
`POST /api/public/handheld/transfer/receive-confirm`
```json
{ "transfer_id": "uuid" }
```
- 校验发出方扫的所有 EPC 都在收货扫描里，否则 422 (`missingReceive`)。
- 成功后增加收货方库存，EPC 状态变 `in_stock` 且 `current_location_id` 变更，调拨单变 `received`。

---

## HTTP 状态码

| 状态 | 含义 |
| ---- | ---- |
| 200  | 成功 |
| 400  | 入参不合法 |
| 401  | 缺少/无效 token |
| 403  | 设备被停用 / 库位/角色不匹配 |
| 404  | 资源不存在 |
| 409  | 状态冲突（例如 submit 一个非 scanning 的盘点单） |
| 422  | 校验失败（盘点数量不一致、调拨数量不匹配） |
| 500  | 服务端错误 |

## CORS

所有接口都启用了通用 CORS（`*`），允许从 APP WebView 跨域调用。
