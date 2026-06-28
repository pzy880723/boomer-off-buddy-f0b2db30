
## 背景

当前 Web 登录其实是「手机号 → `phoneToEmail()` 转伪邮箱 → Supabase 邮箱密码登录」，所以能成功。
而 APP bootstrap 里 `body.phone` 直接走了 `signInWithPassword({ phone })`，命中 Supabase 原生 phone provider —— 后台没开 → 422 `phone_provider_disabled`。

目标：
1. 立刻修好 APP 手机号密码登录（不开 Supabase phone provider，复用 `phoneToEmail`）。
2. 新增「手机验证码登录」，Web、APP 双端可用；原密码登录保留。
3. 短信通道：腾讯云 SMS。

---

## Phase A · 修 bootstrap 的手机号密码登录（5 分钟）

`src/routes/api/public/handheld/auth.bootstrap.ts` 里把：

```
body.email ? signInWithPassword({email}) : signInWithPassword({phone: body.phone!})
```

改成统一走邮箱：

```
const email = body.email ?? phoneToEmail(body.phone!)
signInWithPassword({ email, password: body.password })
```

这样 APP 用「ERP 手机号 + 密码」就能直接登录，和 Web 完全一致。

---

## Phase B · 手机验证码登录

### B1. 短信通道：腾讯云 SMS

需要新增 4 个 secret（用 `add_secret` 让用户填）：

- `TENCENTCLOUD_SECRET_ID`
- `TENCENTCLOUD_SECRET_KEY`
- `TENCENT_SMS_SDK_APP_ID`（SmsSdkAppId，1400xxxxxx）
- `TENCENT_SMS_SIGN_NAME`（已审核通过的签名，例如「博墨严选」）
- `TENCENT_SMS_TEMPLATE_ID`（验证码模板 ID，模板内容形如「您的验证码是 {1}，5 分钟内有效。」）

实现一个服务端 helper `src/server/sms.tencent.server.ts`，按腾讯云 TC3-HMAC-SHA256 签名直接 fetch `https://sms.tencentcloudapi.com`（不引入 SDK，避免 Worker 兼容性问题）。

### B2. 数据表：`auth_phone_otp`

```text
auth_phone_otp
- id uuid pk
- phone text       (11 位)
- code_hash text   (sha256(code + phone))
- purpose text     ('login')
- expires_at timestamptz   (now() + 5 min)
- consumed_at timestamptz
- attempts int default 0
- ip text, user_agent text
- created_at timestamptz
索引：(phone, created_at desc)
```

RLS：仅 `service_role`，匿名/认证均无权限（接口走 service role）。
另加 `cleanup_expired_otp()` 定时清理（可选，先不接 cron）。

### B3. 公共 API（两个路由，都在 `/api/public/auth/otp/*`，不需要鉴权）

`POST /api/public/auth/otp/send`
- body: `{ phone: string, purpose?: 'login' }`
- 校验：手机号格式；同 phone 60 秒内只能发 1 次，10 分钟内最多 5 次，单 IP 1 小时最多 20 次。
- 生成 6 位数字 → 写 `auth_phone_otp`（存 hash，不存明文）→ 调腾讯云 SMS 发送。
- 返回 `{ ok: true, ttl: 300 }`。失败返回标准 `{ ok:false, error, code }`。

`POST /api/public/auth/otp/verify`
- body: `{ phone, code }`（Web 用）或附加 `install_id, device_label, capabilities…`（APP 用，复用 BootstrapReq 字段）。
- 取该 phone 最新未消费、未过期记录；`attempts >= 5` 锁定；hash 比对成功后标记 `consumed_at`。
- 解析对应 ERP 用户：`email = phoneToEmail(phone)`。
  - 若 `auth.users` 不存在 → **不自动注册**，返回 `code: 'user_not_found'`（避免任何人发条短信就能注册）。注册仍由管理员在后台完成。
  - 若存在 → 用 `supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email })` 拿到 `properties.hashed_token`，再用一个 server 侧 `verifyOtp({ token_hash, type: 'magiclink' })` 换出 `session`（access_token + refresh_token）。
- Web 模式：直接返回 `{ session: { access_token, refresh_token, expires_at }, user }`，前端用 `supabase.auth.setSession()` 落地。
- APP 模式：当带 `install_id` 时，复用 bootstrap 后半段（upsert `inv_handheld_devices`、读 roles/locations），返回 **完整 BootstrapRes**（`device_token / access_token / session_token / refresh_token / device / user / locations`）—— 让 APP 一步登录到位。

### B4. Web 登录页改造（`src/routes/login.tsx`）

- 顶部新增 Tabs：「密码登录 / 验证码登录」，默认密码登录。
- 验证码登录表单：手机号 + 6 位验证码 + 「获取验证码」按钮（60s 倒计时）。
- 提交：调 `/api/public/auth/otp/verify` → `supabase.auth.setSession(res.session)` → 跳 `/dashboard`。
- 错误码 → 中文提示：`user_not_found`「该手机号未注册，请联系管理员」、`otp_expired`、`otp_invalid`、`otp_locked`、`rate_limited` 等。

### B5. OpenAPI / APP

`src/lib/handheld/schemas.ts` 新增：
- `OtpSendReq` / `OtpSendRes`
- `OtpVerifyReq`（含可选 install_id 等）→ 返回 `BootstrapRes`
在 `src/lib/handheld/openapi.ts` 注册两条路径，bump 版本到 **v1.4**。
`docs/handheld-api.md` & `docs/handheld-onboarding.md` 增加「OTP 登录」段，给出 curl 示例 & 错误码表。
跑 `bun run sdk:gen` 更新 `openapi.snapshot.json`。

### B6. 旧 bootstrap 兼容

- 保留 `/auth/bootstrap`（已修好的 Phase A 版本）= 手机号 + 密码。
- 新 `/api/public/auth/otp/send` + `/verify` = 手机号 + 验证码。
- 两者最终返回相同结构，APP 端按用户选择走任意一条。

---

## 技术备注

- 不开启 Supabase 原生 phone provider；继续 `phoneToEmail()` 单一身份源。
- 不用 `supabaseAdmin.auth.admin.createUser` 自动建号，避免短信轰炸即可拿账号。
- 所有 OTP 路由在 `/api/public/*` 下，handler 内部用 service role 直读 `auth_phone_otp`、调腾讯云 API；不暴露任何敏感字段。
- 腾讯云签名实现：纯 Web Crypto / Node `crypto` `Hmac`，无第三方 SDK，Worker 友好。
- 速率限制：表内基于时间窗 + `attempts` 字段计数，无需 Redis。

---

## 交付清单

1. 修 `auth.bootstrap.ts`（Phase A，立即修复 APP 登录）。
2. 新表 `auth_phone_otp` migration。
3. `src/server/sms.tencent.server.ts`（腾讯云 SendSms 签名 + 调用）。
4. `src/routes/api/public/auth/otp.send.ts` & `otp.verify.ts`。
5. `src/lib/handheld/schemas.ts` & `openapi.ts` v1.4；`sdk:gen` 快照。
6. `src/routes/login.tsx` 增加「验证码登录」Tab。
7. `add_secret`：`TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` / `TENCENT_SMS_SDK_APP_ID` / `TENCENT_SMS_SIGN_NAME` / `TENCENT_SMS_TEMPLATE_ID`。
8. 文档：`docs/handheld-api.md` + `docs/handheld-onboarding.md` 更新 OTP 段落。

确认后我按 Phase A → Phase B 顺序实施，并在结尾给你需要在腾讯云控制台准备的「签名 / 模板内容」清单。
