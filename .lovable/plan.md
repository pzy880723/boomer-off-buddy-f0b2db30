
# 给 codex 的交接说明（Handheld APP 开发接力）

我（Lovable，ERP 侧）已经把后端接口和文档全部铺好，下面这份是给你（codex，Android APP 侧）的完整交接。**这份本身不需要我再改 ERP 代码**，你看完决定要不要我补什么，我再进 build mode 动手。

---

## 一、ERP 侧已就绪的东西（你直接用）

- **OpenAPI 真源**：`GET /api/public/handheld/openapi.json`
  - Scalar 文档：`/api-docs`
  - 用它跑 codegen（推荐 `openapi-typescript-codegen` 或 Kotlin 的 `openapi-generator`），不要手抄字段。
- **集成手册**：`docs/handheld-onboarding.md`（v1.2，鉴权头 / token 生命周期 / 错误码 / 调用顺序）。
- **Zod 真源**：`src/lib/handheld/schemas.ts`，所有请求/响应都从这里派生。
- **业务错误码常量**：`src/lib/handheld/errors.ts`（`unlinked / already_exists / transfer_required / unauthorized_location / ai_credits_exhausted` 等）。
- **17 个路由全部上线**（auth/locations/items/rfid/ai 五大族），稳定 URL：
  - 生产：`https://boomer-off-buddy.lovable.app/api/public/handheld/*`
  - 预览：`https://project--2158bffa-7f82-4bc6-9df9-c59319d262f7-dev.lovable.app/api/public/handheld/*`
- **DB 字段补齐**：`inv_skus.barcode`（EAN-13 自动生成）+ `condition_grade` 枚举 N/S/A/B/C/J；裸 EPC 入 `inv_unclaimed_epcs`。

---

## 二、APP 侧建议的开发顺序（按工作流切片）

```text
M1 设备激活 + 登录
M2 RFID 扫描三态（known / unlinked / transfer_required）
M3 智能上架（拍照 → AI 识别 → 上传 → smart-create）
M4 调拨 / 库位切换
M5 盘点
M6 有赞同步状态查看（只读）
```

**M1 设备激活 + 登录**
- 启动读 keystore 里的 `X-Device-Token`，调 `auth/ping`。401 → 扫"设备绑定二维码"（ERP 后台「仓库管理 → 手持终端」生成，内容是 device_token 明文）。
- 登录页：邮箱+密码 → `POST /auth/login` → 拿 `access_token`(2h) + `refresh_token` → 全部写 keystore。
- 后台 worker：access_token 剩 <5min 时调 `auth/refresh`。

**M2 RFID 扫描**
- 持续扫枪事件 → 节流 200ms → `GET /rfid/{epc}`。
- 三态 UI：
  - `known:true` → SKU 卡片 + 库位、可一键调拨。
  - `code:"unlinked"` → CTA「认领到已有 SKU」/「智能上架新建」。
  - 仓库设备扫到非本库位 → 调 `/rfid/transfer-location` 报 `transfer_required` → 跳调拨向导。

**M3 智能上架（核心工作流）**
1. 多张原图 → `POST /items/upload-image?mode=signed` 直传 Supabase（弱网回退 multipart）。
2. 主图 → `POST /ai/recognize-item` 拿建议 title/category/grade/keywords。
3. 可选 → `POST /ai/prepare-listing-image`（Nano Banana 2 抠图/换底）。
4. `POST /items/smart-create`：带 `auto_push_youzan` 开关（默认 false，APP 顶部放个 Switch 让操作员决定）。
5. 拿回 `sku_id + barcode`，本地用 ZPL/ESC-POS 渲染条码标签直接打印（ERP 不出图）。
6. 紧接着 `POST /rfid/bind-item` 把刚才那批 EPC 写到这个 SKU。

**M4 调拨**
- 来源：M2 的 `transfer_required` 或主菜单"新建调拨"。
- 流程：选目标库位 → 扫 N 个 EPC → `POST /rfid/transfer-location` 批量提交。
- 注意 `unauthorized_location` → 提示当前设备无权调到该库位。

**M5 盘点**
- 走 `/stocktake/*` 那组（开会话 → 持续 push EPC → 关会话出差异表）。ERP 端会把差异落到 `inv_stocktake_sessions`，店长在 web 端复核。

**M6 有赞同步状态**
- SKU 详情页只读展示 `youzan_links`：哪几个店铺已绑、上次同步时间、库存是否一致。APP 不直接写有赞，统一走 ERP 后台。

---

## 三、你（codex）要回我的问题

我等你确认下面这些，再决定 ERP 这边是否再加接口/字段，**全部按推荐**也行：

1. **APP 技术栈**：Kotlin + Jetpack Compose（推荐 A）/ Flutter / 别的？影响我要不要顺手生成对应的 SDK 模板。
2. **扫枪硬件**：是不是 Chainway/Urovo 这类标准 Android PDA？要不要我在 `/auth/ping` 响应里加 `device_capabilities`（reader_model / has_printer）字段供 APP 自适应？（推荐 A：加）
3. **离线模式**：要不要支持"无网先扫，回到 WiFi 再批量提交"？如果要，我得加 `/rfid/batch-stock-in` 和幂等键 `client_op_id`（推荐 A：加幂等键，离线队列你 APP 端攒）。
4. **标签打印**：你说自渲染，那需不需要我在 `items/{id}` 里多返 `print_payload: { sku_code, barcode, title_short, price_tag, grade }` 一个扁平结构，省得 APP 自己拼？（推荐 A：加）
5. **推送通知**：调拨被接收、有赞同步失败这类要不要 FCM 推到 APP？（推荐 B：先不做，APP 进前台时主动 `/notifications/since?ts=` 拉取，我加这个接口即可）
6. **AI 识别多图**：当前 `ai/recognize-item` 只吃单张主图。要不要扩成最多 4 张一起送 Gemini？（推荐 A：扩，识别更准）
7. **盘点是否需要"协作模式"**：多台 PDA 同时扫一个会话？（推荐 A：支持，schema 已经留位）
8. **错误上报**：APP crash / 网络错误要不要 POST 到 `/diag/report`，我落表供 web 后台看？（推荐 A：加，方便定位）

回我 "全部按推荐" 或逐条勾选，我就一次性把 `device_capabilities` / `print_payload` / `client_op_id` / `notifications/since` / `ai.recognize-item` 多图 / `diag/report` 这 6 块加上，更新 OpenAPI + onboarding 文档，APP 侧你就可以 `bun run sdk:gen` 拉新版直接编码。

---

## 四、对接的纪律（双方都遵守）

- **字段只改一处**：`src/lib/handheld/schemas.ts`。我改完 push，你 CI 跑 codegen，diff 进 PR。
- **业务状态用 `code` 字段**，不要靠 HTTP status 判断业务分支。
- **写操作必须带 `client_op_id`（一旦加上）**，便于幂等重试。
- **凡是 `requireSupabaseAuth` 路由**，没带 `X-Session-Token` 一律 401，不要把它当登录页。
