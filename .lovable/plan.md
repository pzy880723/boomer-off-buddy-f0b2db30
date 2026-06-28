
# Handheld API v1.2 — codex 确认后的增量实现

codex 已确认「全部按推荐」并补了 7 条具体改动。本轮一次性落地，刷新 OpenAPI，更新文档，方便 APP 端切真实 API。

## 一、Schema / 接口改动（src/lib/handheld/schemas.ts + 对应 route）

1. **`/auth/ping` 增加 `device_capabilities`**
   - schema 加 `DeviceCapabilities`：`reader_model` (enum: `SUNMI_V3` / `RFID_PDA` / `UNKNOWN`)、`has_printer` / `has_rfid_reader` / `has_barcode_scanner` / `has_camera` (bool)。
   - `inv_handheld_devices` 新增列 `capabilities jsonb default '{}'::jsonb`（migration）。
   - `auth.ping` / `auth.me` / `auth.login` 返回里都带 `device_capabilities`。
   - 后台「手持终端」页未来可以编辑，本轮先支持读取 + 默认值。

2. **离线批量入库 `/rfid/batch-stock-in` + `client_op_id` 幂等**
   - 新表 `inv_handheld_op_log`：`device_id`, `client_op_id`, `op_type`, `request_hash`, `response_json`, `created_at`，唯一键 `(device_id, client_op_id)`。
   - 新 route：批量版 `rfid/stock-in`，body = `{ ops: [{ client_op_id, epcs[], scanned_at }] }`，每个 op 独立写 `inv_unclaimed_epcs` 或入库 movement。重复 `client_op_id` 直接回放上次响应。
   - 同时给现有 `inbound/scan`、`rfid/stock-in`、`rfid/bind-item`、`rfid/transfer-location`、`stocktake/scan`、`transfer/*-scan` 的 body 加可选 `client_op_id`，命中走幂等回放。

3. **`print_payload` 扁平结构**
   - schema 新增 `PrintPayload`：`sku_code` / `barcode` / `title_short` (<=24 字符截断) / `price_tag` (`¥` + tier 价) / `grade`。
   - `items/{id}` 和 `items/smart-create` 响应里附 `print_payload`。

4. **轮询通知 `/notifications/since`**
   - 新表 `inv_handheld_notifications`：`id`, `device_id`(nullable, null=广播), `location_id`(nullable), `kind` (`stocktake_assigned` / `transfer_incoming` / `youzan_sync_failed` / `unclaimed_epc_pending` / `system`), `payload jsonb`, `ts`。
   - route：`GET /notifications/since?ts=<iso>&limit=50`，返回按设备 + 当前 location 过滤的通知列表 + `server_ts`，APP 下次拿 `server_ts` 当 since。
   - 不动现有业务流，先只把「调拨发起、盘点指派、有赞同步失败」三处插入通知，其它后续补。

5. **`ai/recognize-item` 支持多图（最多 4 张）**
   - schema：`images: z.array(...).min(1).max(4)`；保留 `image_url` 兼容旧调用。
   - handler：把多张图都喂给 Gemini，prompt 增加「APP 已指定首图为主图，识别请综合判断」。
   - 响应不变。

6. **盘点协作多 PDA**
   - 现状 `stocktake/open` 已 reused，本轮仅在 `inv_handheld_op_log` + `stocktake_scans` 上确认 `(stocktake_id, epc)` 去重 + `device_id` 记录；
   - schema：`StocktakeOpenRes` 加 `participants: [{ device_id, last_scan_at, scan_count }]`，前端/APP 可以看「谁在扫」。
   - `stocktake/scan` 响应回 `participants` 摘要。

7. **错误上报 `/diag/report`**
   - 新表 `inv_handheld_diag`：`id`, `device_id`, `user_id`(nullable), `kind` (`crash` / `network` / `api_error` / `device`), `message`, `payload jsonb`, `app_version`, `os_version`, `created_at`。
   - route：`POST /diag/report`，body 用 Zod 限制 message <= 4KB / payload <= 32KB，强制不接受 `token` / `password` / `secret` 字段名（命中直接 422）。
   - 后台暂不做 UI，先入库。

## 二、统一动作

- **OpenAPI**：openapi.ts 注册全部新 route + 新 schema + 新错误（业务码不增）；运行 `bun run sdk:gen` 刷新 `openapi.snapshot.json`。
- **docs/handheld-onboarding.md**：升级到 v1.2，新增「设备能力 / 离线幂等 / print_payload / 通知轮询 / 多图识别 / 协作盘点 / 诊断上报」7 个小节，附 curl 示例。
- **docs/handheld-handoff-to-codex.md**：在「ERP 已就绪」段尾追加 v1.2 增量清单 + 失败回放示例（`client_op_id` 命中 200 + `replayed: true`）。
- **安全提醒**：codex 提到 `.env`。本轮不动文件，但在 handoff 文档末尾加一行说明：仓库内 `.env` 仅含 `VITE_SUPABASE_URL` / publishable key，service role / 有赞 / Lovable AI 都走平台 secret，不进仓库。

## 三、不做的事

- 不接 FCM。
- 不动现有 11 个 route 的成功路径语义，只追加可选字段。
- 不改 `inv_skus` / `inv_stocks` / `inv_epcs` 现有结构。
- 后台 UI（设备能力编辑、诊断查看、通知中心）本轮全部 skip，留下一轮按需要做。

## 四、迁移概览

- `alter table inv_handheld_devices add column capabilities jsonb default '{}'::jsonb`
- `create table inv_handheld_op_log (...)` + 唯一索引
- `create table inv_handheld_notifications (...)` + `(device_id, ts)` / `(location_id, ts)` 索引
- `create table inv_handheld_diag (...)`
- 全部 4 个表按规范：GRANT to service_role only（设备走 service role 写入），enable RLS + deny-all policy（前端不直接读）。

## 五、交付物

1. 1 个 migration
2. schemas.ts / errors.ts 增量
3. 新增 4 个 route 文件：`rfid.batch-stock-in.ts`、`notifications.since.ts`、`diag.report.ts`、（`ai.recognize-item.ts` 改为多图）
4. 修改 7 个现有 route：注入 `client_op_id` 幂等 + `print_payload` + `device_capabilities` + 协作盘点字段
5. openapi.ts + openapi.snapshot.json
6. docs/handheld-onboarding.md → v1.2
7. docs/handheld-handoff-to-codex.md 追加 v1.2 增量段

确认后我一次性落地。
