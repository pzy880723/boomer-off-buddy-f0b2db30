# 给 Codex 的协作清单（APP 端升级 + AI 对接）

下面分成三段：① 可以直接发给 Codex 的话术；② APP 登录入口要做的事；③ AI 部分要对接的事。Lovable 这边不需要再改后端，全部接口已经上线在 `https://boomer-off-buddy.lovable.app`。

---

## 一、直接发给 Codex 的话术（可复制粘贴）

> **背景**：ERP 后端已经上线手机验证码登录，APP 之前的"手机号 + 密码"流程要全部替换成"手机号 + 6 位短信验证码"。后端、短信、限流都已完成，APP 只改 UI 和调用方式即可。
>
> **新登录主流程（推荐，单次完成登录 + 设备绑定）**
> 1. 用户输入 11 位手机号 → APP 调用 `POST /api/public/auth/otp/send`
>    - body: `{ "phone": "13800001111", "purpose": "login" }`
>    - 不需要任何 header，不需要 `X-Device-Token`
>    - 成功返回 `{ ok: true, data: { ttl: 300 } }`，UI 启动 60 秒倒计时
>    - 失败时 `ok=false`，要展示 `error` 文案；常见 `code`：`rate_limited`、`invalid_phone`、`sms_send_failed`
> 2. 用户输入 6 位验证码 → APP 调用 `POST /api/public/auth/otp/verify`
>    - body 同时携带 bootstrap 字段，让一次请求完成验证 + 设备登记：
>      ```json
>      {
>        "phone": "13800001111",
>        "code": "123456",
>        "install_id": "<APP 持久化的 UUID>",
>        "device_label": "张三的 PDA",
>        "app_version": "1.4.0",
>        "os_version": "Android 14",
>        "capabilities": {
>          "reader_model": "SUNMI_V3",
>          "has_printer": true,
>          "has_rfid_reader": true,
>          "has_barcode_scanner": true,
>          "has_camera": true
>        }
>      }
>      ```
>    - 成功返回结构与 `/auth/bootstrap` 完全一致：`device_token`、`access_token`、`session_token`、`refresh_token`、`device`、`user`、`locations`
>    - APP 把 `device_token` 和 `session_token` 持久化，之后所有业务请求继续按现状带 `X-Device-Token` + `X-Session-Token`
>    - 常见错误 `code`：`otp_not_found` / `otp_expired` / `otp_invalid` / `otp_locked` / `user_not_found`，全部转中文提示
>
> **兼容场景**：已经登录过的设备如果 `device_token` 仍有效，不需要重新走验证码；token 过期或被踢出时再回到验证码登录页。
>
> **要删除/隐藏的旧逻辑**
> - 删除"邮箱 + 密码"登录入口，保留"手机号 + 密码"作为兜底（同一个 `/auth/bootstrap`，已支持手机号→伪邮箱映射）
> - 不再要求用户记忆密码作为日常登录方式
>
> **联调地址**：`https://boomer-off-buddy.lovable.app`，OpenAPI: `/api/public/handheld/openapi.json`（已包含 `/auth/otp/send`、`/auth/otp/verify`，版本 1.4.0）。
>
> **测试账号**：请 Mark 提供一个真实可收短信的手机号（必须先在 ERP 里建好账号），第一次发送有 60 秒/条、10 分钟/5 条、单 IP 1 小时/20 条限流。

---

## 二、APP 登录入口需要 Codex 做的事

1. **登录页 UI 改造**
   - 默认 Tab：「验证码登录」（手机号 + 6 位码 + 倒计时按钮）
   - 次 Tab：「密码登录」（手机号 + 密码，保留给应急/弱网）
   - 移除现有的"邮箱"字样和切换
2. **`install_id` 生命周期**
   - 首次启动生成 UUID 写入安全存储（Android Keystore / iOS Keychain），卸载重装才换新
   - `verify` / `bootstrap` 都用同一个 `install_id`，后端按 `(user_id, install_id)` 复用设备记录
3. **Token 存储与续期**
   - `device_token`：长期有效，加密存储
   - `session_token` / `access_token`：到期前用 `refresh_token` 调 `/auth/refresh` 续期（现有逻辑保留）
   - 收到 `401 unauthorized` 时清掉 session，跳回登录页（保留 `install_id`）
4. **错误码映射文案**：把 `rate_limited` → "发送过于频繁，请稍后再试"、`otp_expired` → "验证码已过期" 等统一沉到 i18n
5. **能力字段对齐**：`capabilities` 必须按 OpenAPI 字段名传（`has_camera` / `has_printer` / `reader_model`），之前出现过的 `camera` / `printer` 旧字段要清理

---

## 三、AI 部分要 Codex 配合对接的事

后端 AI 已经在 ERP 这边跑通了，全部走 Lovable AI Gateway，APP 不需要自己接任何模型。Codex 那边只需要把 APP 的"拍照建商品 / 拍照生成上架图"两条链路指向我们的接口：

| APP 场景 | 调用接口 | 关键说明 |
| --- | --- | --- |
| 拍照识别（建 SKU 时识别商品名/品牌/类目） | `POST /api/public/handheld/ai/recognize-item` | 支持 `image_url`（已上传到 `sku-raw` 桶时）或 `image_base64`；多角度可用 `images[]`（最多 4 张，每张二选一） |
| 生成上架主图（白底/统一构图） | `POST /api/public/handheld/ai/prepare-listing-image` | 入参同上，返回 `{ storage_path, signed_url, mime_type }`，`signed_url` 7 天有效，APP 直接用它展示/下载/打印 |
| 智能建档（识别结果 → 落库 SKU） | `POST /api/public/handheld/items/smart-create` | 接收识别结果 + 用户改动后的字段，后端写入 `inv_skus`、生成条码 |
| 上传原图（先拿到 storage_path 再调 AI） | `POST /api/public/handheld/items/upload-image`（JSON base64）或 `items/upload-image.multipart`（表单） | 上传后拿到 `storage_path`，再传给 AI 接口可省一次大图传输 |

**Codex 需要确认的点**：
1. **图片传递路径优先级**：弱网 → 先 upload-image 拿 `storage_path` → AI 接口只传路径；强网/小图 → 直接走 `image_base64`。建议默认先 upload，再调 AI（节省单次 payload）。
2. **鉴权**：AI 接口属于"写入/AI"类，必须同时带 `X-Device-Token` 和 `X-Session-Token`，否则会被 `unauthorized` 拒掉。
3. **幂等**：`smart-create` 支持 `ClientOpId` header，APP 端建档要生成一次性 UUID，重试用同一个 ID，后端会去重。
4. **错误处理**：模型调用偶尔会拿到 `429`（限流）或 `402`（额度耗尽），APP 端需要展示"AI 暂时繁忙，请稍后重试"并允许重发；不要静默吞错。
5. **同步 OpenAPI**：所有字段名以 `https://boomer-off-buddy.lovable.app/api/public/handheld/openapi.json` 为准，建议用 `openapi-generator` 或 `orval` 重新生成 APP 端 SDK，避免手写字段漂移。

---

## 后续 Lovable 这边的备选动作（看 Codex 反馈再决定）

- 如果 Codex 希望 OTP 校验和 bootstrap 在一次请求里更紧凑，可以在 `otp.verify` 加快捷返回字段（目前已经是合并的）。
- 如果 APP 想要"扫码登录"或"PC 端授权 APP"，可以再加一个 `/auth/qr-bind` 接口。
- 如果短信成本/触达需要监控，可以加一张 `auth_phone_otp_stats` 视图给运营看。

这些都不在本次必做范围，按需求触发即可。