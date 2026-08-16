# BOOMER ERP 原生 APP · 只读诊断报告（未改代码、未提交）

## 1. 401 根因确认：成立

`POST /handheld/location/switch` 与 `POST /handheld/auth/refresh` 的第一步都是设备令牌校验，缺少 `X-Device-Token` 必定 401，且发生在读取 body 之前。

证据：
- `src/server/handheld-auth.server.ts:80-83` — `authenticateDevice` 读取 `x-device-token`，缺失即 `err("Missing X-Device-Token", 401)`。
- `src/routes/api/public/handheld/auth.refresh.ts:12-13` — 处理器第一行 `authenticateDevice(request)`，失败直接返回，`refresh_token` 根本没被解析。
- `src/routes/api/public/handheld/location/switch`（`location.switch.ts:19-21`）— 先 `authenticateDevice`，再 `resolveSessionUser`；后者缺失才返回 `code: "unauthorized"`。

为什么 GET locations / products / dashboard 是 200：`locations.ts:16-17` 同样要设备令牌，说明这些 GET 请求 iOS 端是带了 `X-Device-Token` 的；只有这两个 POST 漏带。因此这是**客户端请求头缺失**，不是服务端会话过期。区分方法：401 body 里 `error="Missing X-Device-Token"`（无 `code` 字段）= 没带设备令牌；`error="Invalid token"` = 设备令牌错/被删；`code:"unauthorized"` + `"Missing session token"` = 只缺用户会话。

另一个连带效应：`auth/refresh` 401 后 APP 拿不到新的 Supabase token，会话到期后 `location/switch` 即使补上设备令牌也会因缺 session 再 401，属于同一条链的次生现象。

## 2. 两个接口的当前契约

`POST /api/public/handheld/auth/refresh`
- Header（必填）：`X-Device-Token`
- Body：`{ "refresh_token": string(min 1) }`（`schemas.ts:985-987`）
- 200：`{ ok:true, data:{ access_token, refresh_token, expires_at } }`
- 401：缺设备令牌 / 设备停用(403) / Supabase 刷新失败（`code:"unauthorized"`）

`POST /api/public/handheld/location/switch`
- Header（必填）：`X-Device-Token` **和** `X-Session-Token`（或 `Authorization: Bearer`）
- Body：`{ "location_id": uuid }`（`schemas.ts:521-523`）
- 200：`{ ok:true, data:{ device_id, location:{id,name,kind,is_active} } }`
- 401 `unauthorized`（缺 session）/ 403 `location_forbidden`（无该库位权限）/ 404（库位不存在）/ 403（库位停用）

最近可观察错误：`inv_handheld_op_log` 近 7 天 0 条记录（这两条路径本来也不写 op_log），Lovable 侧近 1 小时应用日志无相关条目；401 只体现在腾讯生产 Nginx/PM2 访问日志里，ERP 端无结构化留存。

## 3. 拍照上架链路审计

顺序：`POST /items/upload-image`（或 `/items/upload-image/multipart`）→ `POST /ai/prepare-listing-image`（可选，输出 `sku-listing` 的 `storage_path`）→ `POST /ai/recognize-item` → `POST /items/smart-create`。四个接口都要 `X-Device-Token`。

### smart-create 必填 / 关键字段（`schemas.ts:780-824`）
必填只有三个：
- `name`（1-120）
- `category`：`ProductCategoryCode` 枚举，且服务端再校验必须是**启用的叶子类目**（`items.smart-create.ts:82-86`，失败 422）
- `price_tier`：正数 ≤ 9999.9

可选但影响结果：
- `location_id`：可省略，缺省用设备默认库位；两者都没有 → 400（`items.smart-create.ts:92-94`）
- `image_storage_paths`：`[{bucket:"sku-raw"|"sku-listing", storage_path}]`，最多 6 条，第 0 张为主图；服务端归一为 `bucket/path` 存入 `inv_skus.image_paths`
- `image_url`：仅兼容旧版；带 `token=` 的 signed URL 会被丢弃不落库（`items.smart-create.ts:58-65`）
- `is_custom_price`：true → 独立 SKU + `inventory_policy='tracked'`；false → 复用同 category+price_tier+name 的标准 SKU
- `epcs`、`auto_push_youzan`、`client_op_id`（幂等）

### grade vs condition_grade —— 确实存在命名不一致
- `ai/recognize-item` 返回的是 **`condition_grade`**（`schemas.ts:625`）
- `smart-create` 接收的是 **`grade`**（`schemas.ts:787`），落库到 `inv_skus.grade`
- SKU 详情同时返回两者，`grade` 标注为"兼容旧字段，等同 condition_grade"（`schemas.ts:1018-1019`）

后果：APP 若把识别结果的 `condition_grade` 原样透传给 smart-create，该字段被 zod 静默丢弃（对象非 strict），SKU 的 grade 变 null——不会报错，只会丢数据。同理没有 `category_code` 这个字段名，只有 `category`；传 `category_code` 也会被静默忽略，然后因缺 `category` 触发 400 validation_error。

### 近期自定义 SKU 的 image_paths（只读 SQL）
近 14 天 `is_custom_price=true`：总数 2，`image_paths` 非空 2，空 0，最近创建 2026-08-03 18:04 UTC。
最近 5 条自定义 SKU 明细：
- 2026-08-03 18:04 porcelain_drinkware，3 图，首图 `sku-listing/2026-08-03/.../...png`，grade=A，corrected
- 2026-08-03 17:22 porcelain_drinkware，3 图，同一首图，grade=A，corrected
- 2026-07-18 porcelain_tableware，1 图，grade=A，auto_classified
- 2026-07-12 ai_low_confidence，**0 图**，仅有 image_url，grade=N，fallback
- 2026-07-04 daily_misc，1 图，grade=N，legacy

结论：图片落库链路正常，`image_paths` 存的是持久私桶路径而非 signed URL，符合设计。唯一 0 图的那条是 7-12 的 fallback 老数据（走的是 image_url 兼容路径）。另注意 8-03 两条首图路径完全相同，说明同一批照片被建了两个 SKU，属于重复提交/未复用，不是图片丢失。

## 4. 是否需要后端改动

- **401 本身：不需要后端改动。** 修复点在 iOS 客户端——所有 `/api/public/handheld/*` 请求（含 refresh）统一注入 `X-Device-Token`，`location/switch` 再额外带 `X-Session-Token`。
- **建议的低风险后端增强（需你批准后再做）：**
  1. `auth/refresh` 在 401 时区分返回 `code:"missing_device_token"` / `"invalid_device_token"`，便于 APP 侧自愈与日志定位。
  2. `smart-create` 接受 `condition_grade` 作为 `grade` 的别名（并保留 `grade`），消除静默丢字段。
  3. 对 smart-create 请求中出现的未知字段（如 `category_code`）在响应里回传一个 `ignored_fields` 提示，避免"传了但没生效"。
  4. 在 handheld 401/403 分支写一条 `inv_handheld_diag`，让这类问题下次可从数据库直接聚合。

## 声明

本轮为只读诊断：未修改任何代码、未提交、未写数据库、未部署腾讯、未执行有赞写操作，未输出任何 token、手机号或密钥。
