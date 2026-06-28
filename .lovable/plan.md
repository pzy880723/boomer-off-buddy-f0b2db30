# Handheld APP 对接 v1.2 实施计划

Codex 已确认 8 个问题全部按推荐方案执行。下面是 ERP 侧要落地的全部改动。

## 一、数据库迁移（一次 migration）

1. **`inv_skus` 新增字段**
   - `barcode text unique` — 全局唯一 EAN-13；新增 SKU 时由触发器自动生成（13 位，国别前缀 `200`，校验位算到位）。
   - `condition_grade text` — 枚举 `N/S/A/B/C/J`，加 CHECK。
   - 历史数据：触发器回填 barcode；condition_grade 留 NULL。

2. **`inv_unclaimed_epcs`** 已存在，补 RLS 策略 + 索引 `(location_id, created_at desc)`。

3. **新表 `handheld_sessions`**
   - `id uuid pk`, `user_id uuid`, `device_id uuid`, `location_id uuid`, `access_token_hash text`, `refresh_token_hash text`, `expires_at timestamptz`, `refreshed_at timestamptz`, `revoked_at timestamptz`, `created_at`。
   - access_token 默认 2h，refresh_token 30d。
   - RLS：仅 service_role；GRANT service_role。

4. **`inv_stock_movements` 审计**：补 `device_id uuid`、`session_id uuid` 两列，用于追踪是哪台机/哪次登录写入。

5. **`gen_ean13()` 函数** + `tg_inv_skus_fill_barcode` 触发器。

## 二、新增 / 完善 Route（全部位于 `src/routes/api/public/handheld/`）

| 路径 | 方法 | 说明 |
|---|---|---|
| `auth.login` | POST | 已存在；返回 `access_token` + `refresh_token` + `user` + `locations` |
| `auth.refresh` | POST | 新增；用 refresh_token 换新 access_token |
| `auth.me` | GET | 新增；返回当前 user/device/location |
| `auth.logout` | POST | 新增；撤销 session |
| `session.location` | PUT | 新增；切换当前 session 的 location |
| `locations` | GET | 已存在 |
| `ai.recognize-item` | POST | 已存在；Gemini 2.5 Pro |
| `ai.prepare-listing-image` | POST | 已存在；Nano Banana 2 |
| `items.upload-image` | POST | 已存在；返回 signed PUT URL；**新增** multipart 直传分支（`mode=multipart`） |
| `items.smart-create` | POST | 已存在；默认 `auto_push_youzan=false`，true 时入 youzan_stock_sync_queue |
| `items.$id` | GET | 新增；返回 SKU 详情 + barcode + condition_grade + 当前库存 |
| `items.$id.sync-status` | GET | 已存在 |
| `rfid.$epc` | GET | 已存在；返回 `unlinked`/已绑 SKU |
| `rfid.bind-item` | POST | 已存在 |
| `rfid.stock-in` | POST | 新增；扫到裸 EPC 时入 `inv_unclaimed_epcs` |
| `rfid.transfer-location` | POST | 已存在 |
| `stocktake.*` | 已存在 | 复用 |

所有写请求强制校验 `X-Device-Token` + `X-Session-Token`，并把 `device_id`/`session_id` 透传到 `inv_apply_movement` 审计。

## 三、统一业务状态码

在 `src/lib/handheld/errors.ts` 定义并写入 OpenAPI `components.responses`：

| HTTP | `code` | 触发场景 |
|---|---|---|
| 401 | `unauthorized` | token 无效/过期 |
| 401 | `unauthorized_location` | session 当前 location 与请求不符 |
| 404 | `unlinked` | EPC 未绑定任何 SKU（GET /rfid/{epc}） |
| 409 | `already_exists` | barcode/EPC 已绑定其它 SKU |
| 409 | `transfer_required` | EPC 当前不在本 location，需要走调拨 |
| 422 | `validation_error` | Zod 校验失败 |
| 429 | `rate_limited` | AI 网关限流 |
| 402 | `ai_credits_exhausted` | AI 网关额度耗尽 |

每个 route 的 OpenAPI `responses` 显式列出可能返回的 code，APP 端直接 switch。

## 四、OpenAPI / Schema 更新

- `src/lib/handheld/schemas.ts`：新增 `BarcodeSchema`、`ConditionGradeEnum`、`HandheldErrorSchema(code, message, details?)`、refresh/me/logout/session-location/stock-in 的 in/out schema。
- `src/lib/handheld/openapi.ts`：
  - 在 `components.securitySchemes` 声明 `DeviceToken`（header `X-Device-Token`）+ `SessionToken`（header `X-Session-Token`）。
  - 每个写接口的 `security` 同时引用两者。
  - 把上表所有业务 code 注册为 `components.responses` 复用引用。
- 重新生成 `openapi.snapshot.json`，drift check 通过。

## 五、文档

新建 `docs/handheld-onboarding.md`，覆盖：登录/刷新流程、X-Device-Token 申领、location 切换、智能上架（含 auto_push_youzan）、裸 EPC 入库、调拨、错误码表、EAN-13 / condition_grade 字段说明、signed URL vs multipart 二选一、示例 curl + TS fetch。

更新 `docs/handheld-api.md` 顶部指向 onboarding 文档与 `/api-docs` Scalar UI。

## 六、验收

1. `bun run openapi:check` 无 drift。
2. `tsgo` 通过。
3. 手动调一次：login → recognize → smart-create(auto_push_youzan=false) → upload-image(signed) → bind-item → transfer-location → 触发一次 `transfer_required` 与 `unlinked`，确认 code 正确。

确认后我会按上述顺序执行（先 migration，再 schemas/routes/openapi/docs，最后跑 drift check）。
