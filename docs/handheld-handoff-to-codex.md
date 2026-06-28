# Handheld APP 接力交接（Lovable → codex）

> 给 Android APP 开发者（codex）的一次性交接说明。
> ERP 侧（Lovable）已经把后端接口、文档、SDK 真源全部铺好，APP 侧可以直接接。

## 0. 直接能用的链接

| 用途 | URL |
| --- | --- |
| OpenAPI 真源（codegen 用） | https://boomer-off-buddy.lovable.app/api/public/handheld/openapi.json |
| Scalar 在线文档 | https://boomer-off-buddy.lovable.app/api-docs |
| 生产 baseURL | https://boomer-off-buddy.lovable.app/api/public/handheld/ |
| 预览 baseURL（dev 调试） | https://project--2158bffa-7f82-4bc6-9df9-c59319d262f7-dev.lovable.app/api/public/handheld/ |
| 集成手册 | [`./handheld-onboarding.md`](./handheld-onboarding.md) |
| Zod 真源（字段定义） | `src/lib/handheld/schemas.ts` |
| 业务错误码常量 | `src/lib/handheld/errors.ts` |

---

## 一、ERP 侧已就绪

- 17 个路由全部上线（`auth` / `locations` / `items` / `rfid` / `ai` 五大族）。
- **鉴权**：写请求 `X-Device-Token` + `X-Session-Token`，只读接口允许只带 device token。
- **登录**：复用 ERP Supabase 邮箱密码 + `user_roles`，`access_token` 2 小时，`refresh_token` 长效。
- **AI**：Lovable AI Gateway，识别用 Gemini 2.5 Pro，抠图换底用 Nano Banana 2。
- **DB 新字段**：
  - `inv_skus.barcode`（EAN-13，新建 SKU 时自动生成，全局唯一）
  - `inv_skus.condition_grade` 枚举 `N / S / A / B / C / J`
  - `inv_unclaimed_epcs`：裸 EPC 待认领队列，由 `/rfid/stock-in` 写入
- **业务错误码**（出现在响应体 `code` 字段，APP 按 code 分支处理）：
  `unauthorized` / `unauthorized_location` / `invalid_body` / `validation_error` /
  `not_found` / `unlinked` / `already_exists` / `transfer_required` /
  `rate_limited` / `ai_credits_exhausted` / `internal_error`

---

## 二、APP 侧建议开发顺序（按工作流切片）

```text
M1 设备激活 + 登录
M2 RFID 扫描三态（known / unlinked / transfer_required）
M3 智能上架（拍照 → AI 识别 → 上传 → smart-create → 打条码）
M4 调拨 / 库位切换
M5 盘点（开会话 → 持续扫 → 关会话出差异）
M6 有赞同步状态查看（只读）
```

### M1 设备激活 + 登录

- 启动读 keystore 里的 `X-Device-Token`，调 `GET /auth/ping`。
  - 401 → 扫"设备绑定二维码"（后台 → 仓库管理 → 手持终端 生成，内容是 device_token 明文）。
- 登录页：邮箱+密码 → `POST /auth/login` → 拿 `access_token` + `refresh_token` → 全部写 keystore。
- 后台 worker：access_token 剩 <5min → `POST /auth/refresh`。
- 启动期：`GET /auth/me` 回填当前操作员。

### M2 RFID 扫描

- 持续扫枪事件 → 节流 200ms → `GET /rfid/{epc}`。
- 三态 UI：
  - `known: true` → SKU 卡片 + 当前库位，可一键调拨。
  - `ok: true, code: "unlinked"`（200 响应里！）→ CTA「认领到已有 SKU」/「智能上架新建」。
  - 仓库设备扫到非本库位的物品 → 调 `/rfid/transfer-location` 报 `transfer_required` → 跳调拨向导。

### M3 智能上架（核心工作流）

1. 多张原图 → `POST /items/upload-image?mode=signed` 直传 Supabase（弱网回退 `mode=multipart`）。
2. 主图 → `POST /ai/recognize-item` 拿建议 title / category / grade / keywords。
3. 可选 → `POST /ai/prepare-listing-image`（抠图换底）。
4. `POST /items/smart-create`：APP 顶部放 Switch 控制 `auto_push_youzan`（默认 false）。
5. 拿回 `sku_id + barcode + label`，APP 自渲染 ZPL/ESC-POS 标签直接打印。
6. 紧接 `POST /rfid/bind-item` 把刚才那批 EPC 绑到这个 SKU。

### M4 调拨

- 入口：M2 的 `transfer_required` 或主菜单"新建调拨"。
- 流程：选目标库位 → 扫 N 个 EPC → `POST /rfid/transfer-location` 批量提交。
- 注意：`unauthorized_location` 表示当前设备无权调到该库位，提示切换设备/库位。

### M5 盘点

- `/stocktake/*`：开会话 → 持续 push EPC → 关会话出差异表。
- ERP 端落到 `inv_stocktake_sessions`，店长在 web 端复核并确认差异。

### M6 有赞同步状态

- SKU 详情页只读展示 `youzan_links`：哪几个店铺已绑、上次同步时间、库存是否一致。
- APP 不直接写有赞，统一走 ERP web 后台。

---

## 三、给 codex 的 8 个问题（每条都标了推荐项）

Lovable 等你回完这 8 条，会一次性把对应接口/字段补全并刷新 OpenAPI。

1. **APP 技术栈**：Kotlin + Jetpack Compose（推荐 A） / Flutter / 其他？
2. **扫枪硬件**：是否 Chainway/Urovo 等标准 Android PDA？是否需要 `/auth/ping` 返回 `device_capabilities`（reader_model / has_printer）供 APP 自适应？（推荐 A：加）
3. **离线模式**：是否需要"无网先扫、回到 WiFi 批量提交"？如要，ERP 加 `/rfid/batch-stock-in` 和幂等键 `client_op_id`。（推荐 A：加幂等键，离线队列 APP 端攒）
4. **标签打印结构**：是否在 `items/{id}` 多返一个扁平 `print_payload: { sku_code, barcode, title_short, price_tag, grade }`，省得 APP 自己拼？（推荐 A：加）
5. **推送通知**：调拨被接收、有赞同步失败要不要 FCM？（推荐 B：先不做，APP 进前台主动 `/notifications/since?ts=` 拉取，ERP 提供该接口即可）
6. **AI 识别多图**：当前 `ai/recognize-item` 只吃单张主图，要不要扩成最多 4 张一起送 Gemini？（推荐 A：扩）
7. **盘点协作模式**：多台 PDA 同时扫一个会话？（推荐 A：支持，schema 已预留）
8. **错误上报**：APP crash / 网络错误是否 POST 到 `/diag/report` 落表供 web 后台查？（推荐 A：加）

### 回信模板（codex 复制这段填即可）

```
1. A / B（如选 B 注明栈名）
2. A / B
3. A / B
4. A / B
5. A / B
6. A / B
7. A / B
8. A / B
其他需求：
```

或者直接回："全部按推荐"。

---

## 四、对接纪律（双方都遵守）

- **字段只改一处**：`src/lib/handheld/schemas.ts` 是真源。Lovable 改完 push，APP 侧 CI 跑 codegen，diff 进 PR。
- **业务状态用 `code` 字段**，不要靠 HTTP status 判断业务分支。
- **写请求一律带 `client_op_id`（加上后）**，便于幂等重试。
- **`requireSupabaseAuth` 路由没带 `X-Session-Token` 一律 401**，不要把它当登录页。
- **永远不要把 `X-Device-Token` / `X-Session-Token` 写进 URL 或日志**，只走 header + keystore。
