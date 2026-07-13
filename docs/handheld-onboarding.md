# Handheld APP Onboarding — v1.3

> 👉 一次性接力交接见 [`./handheld-handoff-to-codex.md`](./handheld-handoff-to-codex.md)（含 APP 开发顺序 + 待确认问题清单）。
>
> 所有接口都在 `/api/public/handheld/*` 前缀下（绕过站点登录）。
> OpenAPI: https://boomer-off-buddy.lovable.app/api/public/handheld/openapi.json
> Scalar UI: https://boomer-off-buddy.lovable.app/api-docs


## 1. 启动流程（v1.3 推荐：APP 自助引导）

**APP 账号 = ERP 账号**（同一套 Supabase Auth）。无需后台预创建设备。

```
1. APP 首装：生成稳定 install_id（UUID/ULID），写入 keystore（卸载重装才会变）。
2. 登录页：用户输 ERP 邮箱（或手机号）+ 密码。
3. POST /api/public/handheld/auth/bootstrap     ← 不带 X-Device-Token
     { email | phone, password, install_id, device_label?, capabilities?, app_version?, os_version? }
4. 服务端校验 ERP 账号 → 按 (owner_user_id, install_id) upsert 设备 → 返回：
     { device_token, device, access_token, session_token, refresh_token, expires_at, user, locations }
5. APP 把 device_token + access_token/session_token + refresh_token 全部存 keystore。
6. 若 device.location_id 为 null：让用户从 locations 选一个，调 POST /location/switch。
7. 之后每个请求都带：
     X-Device-Token:  <device_token>
     X-Session-Token: <access_token>
```

> 同一 ERP 账号在多台 PDA 上各自登录会得到各自的 device_token（按 install_id 区分）。

## 1b. 鉴权头

```
X-Device-Token: <device_token>    # 由 /auth/bootstrap 颁发并长期有效
X-Session-Token: <access_token>   # Supabase access token，2h 过期 → /auth/refresh
```

- `X-Device-Token` 决定设备绑定的库位（warehouse / shop）。
- `X-Session-Token` 决定操作员审计（user_id 写入 movement / op_log）。
- 只读接口（`auth/ping`, `sku/by-epc`, `sku/search`, `items/{id}`）允许只带 Device token。
- 旧的 `/auth/login` 保留兼容，但要求 X-Device-Token 已存在；新接入一律走 `/auth/bootstrap`。

## 2. Token 生命周期

- `/auth/bootstrap` 返回 `access_token`（2 小时）+ `session_token`（等同 access_token，用于 `X-Session-Token`）+ `refresh_token`。
- access_token 过期前 5 分钟 APP 调 `/auth/refresh` 换新。
- `/auth/me` 用于启动期回填当前操作员；`/auth/logout` 吊销 session（device_token 不变，下次还能 bootstrap）。
- `device_token` 不主动过期；如果后台在「仓库管理 → 手持终端」停用设备，所有接口会返回 `403 / unauthorized_location`。


## 3. 业务错误码（`code` 字段）

| code | 何时出现 | APP 建议处理 |
| --- | --- | --- |
| `unauthorized` | 缺少/无效 token | 跳登录页 |
| `unauthorized_location` | 设备库位不允许该操作 | 提示「请切换库位」 |
| `invalid_body` / `validation_error` | 入参缺字段 / 数量不一致 | toast 错误明细 |
| `not_found` | 资源不存在 | toast「未找到」 |
| `unlinked` | EPC 未绑定 SKU | 跳「认领 / 智能上架」流程 |
| `already_exists` | EPC 已绑到别的 SKU | 提示冲突，给「查看现有 SKU」按钮 |
| `transfer_required` | 物品当前在别的库位 | 引导创建调拨单 |
| `rate_limited` | 触发限流 | 退避重试 |
| `ai_credits_exhausted` | Lovable AI gateway 配额满 | 提示稍后再试 |
| `internal_error` | 服务端兜底 | toast，自动重试 1 次 |

> 注意 `unlinked` 会出现在 `/rfid/{epc}` 的 **200** 响应里（`ok:true, code:"unlinked"`），代表"扫到了但未绑定"；APP 直接按 code 分支即可。

## 4. 新增字段

- `inv_skus.barcode` — EAN-13，全局唯一，新建 SKU 时自动生成；`smart-create` 返回 `barcode` + `label.barcode`。
- `inv_skus.condition_grade` (复用 `grade` 列) — 枚举 `N | S | A | B | C | J`，APP 可直接读 `condition_grade`。
- `inv_unclaimed_epcs` — 裸 EPC 待认领队列，由 `/rfid/stock-in` 写入。

## 5. 图片上传两种模式

`POST /items/upload-image` 接受 `mode`:

- `signed`（默认）— 返回 Supabase PUT signed URL，APP 直传，省服务器带宽。
- `multipart` — 返回 ERP 中转 POST URL（`/items/upload-image/multipart`），APP 走 `multipart/form-data`（字段名 `file`），适合受限网络。

两种模式都返回同样的 7 天 signed `read_url`。

## 6. 推荐调用顺序

1. 启动：`auth/ping` 验设备 → 若 401 引导扫绑定二维码；
2. 登录：`auth/login` 拿 token → 存 keystore；
3. 进入扫描：每条 EPC 触发 `GET /rfid/{epc}`
   - `known:true` → 直接显示 SKU 卡；
   - `code:unlinked` → 跳「认领」或「智能上架」；
4. 智能上架：`ai/recognize-item` → `items/upload-image`（×N） → `ai/prepare-listing-image`（可选） → `items/smart-create`（`auto_push_youzan` 默认 false；开启后发布到所选门店库位绑定的有赞分店并同步库存）；
5. 出现 `transfer_required` / `already_exists` → 进入调拨或冲突处理；
6. 后台静默：每 30 分钟 `auth/refresh`。

## 7. 字段同步约定

ERP `src/lib/handheld/schemas.ts` 是唯一真源。任何改动都会反映到 `/openapi.json`，APP 端通过 `bun run sdk:gen`（或 APP 自己的代码生成）拉取并重生成。

## 8. v1.2 新增（codex 已确认全部按推荐）

### 8.1 设备能力上报
- `auth/ping` 和 `auth/me` 返回 `device_capabilities`（`reader_model` / `has_printer` / `has_rfid_reader` / `has_barcode_scanner` / `has_camera`），以及 `app_version` / `os_version`。
- 上报方式：`POST /auth/login` body 里可带 `capabilities` / `app_version` / `os_version`，服务端写回 `inv_handheld_devices`。

### 8.2 离线批量入库（幂等）
- `POST /rfid/batch-stock-in`：一次最多 50 个 op，每个 op 1-500 个 EPC。
- 每个 op 必须带 `client_op_id`（建议 UUIDv4），ERP 按 `(device_id, client_op_id)` 持久化响应；重复提交直接回放，`replayed: true`。
- 单点接口 `rfid/stock-in` / `rfid/bind-item` / `rfid/transfer-location` / `items/smart-create` 也支持可选 `client_op_id` 字段，同样幂等。

### 8.3 扁平打印 payload
- `items/smart-create` 与 `GET /items/{id}` 都返回 `print_payload`：
  ```json
  { "sku_code": "VG...", "barcode": "690...", "title_short": "≤24 字符", "price_tag": "¥699", "grade": "A" }
  ```
- APP 自渲染 ZPL / ESC-POS；ERP 不维护模板。

### 8.4 通知轮询
- `GET /notifications/since?ts=<iso>&limit=50`：
  - 不传 `ts`：返回最近的 50 条；之后用响应里的 `server_ts` 作为下一次 `ts`。
  - `kind` 枚举：`stocktake_assigned` / `transfer_incoming` / `youzan_sync_failed` / `unclaimed_epc_pending` / `system`。
  - 服务端按 `device_id` / `location_id` 过滤，只下发给本设备 / 本库位 / 全局事件。
- 推荐前台 30s 一次，后台 5min 一次。

### 8.5 AI 多图识别
- `POST /ai/recognize-item` 兼容旧的 `image_url` / `image_base64` 单图字段；
- v1.2 推荐用 `images: [{ image_url | image_base64 }]`，**最多 4 张**，`images[0]` 视为主图，其余为细节/不同角度。

### 8.6 协作盘点
- `stocktake/scan` 接受 `device_id`（服务端自动填当前设备）；
- 多台 PDA 可同时往同一个盘点会话上传，按 `(stocktake_id, epc)` 去重。

### 8.7 错误上报
- `POST /diag/report`：`kind` ∈ `crash | network | api_error | device`；可选 `payload` / `app_version` / `os_version`。
- 安全提醒：**不要在 payload 里上传 token、密码、原始 RFID 报文**，只上报 hash / 摘要。
