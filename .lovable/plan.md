## 只读诊断报告（未修改任何代码、未发布、未发送短信）

### 1. 腾讯短信相关环境变量

按你给的名字逐一核对生产 Secrets（值不显示）：

| 你要求的变量名 | 生产状态 |
|---|---|
| `TENCENT_SECRET_ID` | ❌ 缺失（实际使用的是 `TENCENTCLOUD_SECRET_ID`） |
| `TENCENT_SECRET_KEY` | ❌ 缺失（实际使用的是 `TENCENTCLOUD_SECRET_KEY`） |
| `TENCENT_SMS_SDK_APP_ID` | ✅ 存在 |
| `TENCENT_SMS_SIGN_NAME` | ✅ 存在 |
| `TENCENT_SMS_TEMPLATE_ID` | ✅ 存在 |

补充：代码 `src/server/sms.tencent.server.ts` 里读的密钥变量名是 `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`（带 `CLOUD`），这两个在生产 Secrets 中 **均存在**。也就是说：
- 如果按“你列出的命名（不带 CLOUD）”核对 → 缺 2 个；
- 如果按“代码实际读取的命名（带 CLOUD）”核对 → 5 个全部齐全，短信调用具备发送条件。

请确认你希望的命名口径；如需统一改名为 `TENCENT_SECRET_ID/KEY`，那是一次改动（代码 + 新增 Secret），不在本次只读诊断范围。

### 2. `/api/public/auth/otp/send` 归属

- **归属：ERP 员工登录（含 PC Web 端 + 手持 APP 端），不是消费者登录。**
- 证据：
  - `src/routes/login.tsx` 第 128 行调用 `/api/public/auth/otp/send`——这是 ERP 后台登录页。
  - 配对的 `/api/public/auth/otp/verify` 里，校验通过后会：
    1. 用 `phoneToEmail(phone)` 拼成 `{phone}@users.local` 伪邮箱；
    2. 调用 `supabaseAdmin.auth.admin.listUsers` 查找已有 ERP 用户；
    3. **找不到就直接返回 `user_not_found / 该手机号未注册，请联系管理员`**，不会创建任何账号；
    4. 找到后签发 Supabase 员工 session，可选带 `install_id` 时再绑定 `inv_handheld_devices`（手持机）。
  - 完全没有触碰 `commerce_customers` / `commerce_customer_identities`。消费者账号走的是腾讯云 JWKS + `src/server/storefront-auth.server.ts`，与本接口无关。

- **是否自动创建消费者账号：否。** 也不会自动创建 ERP 员工账号；未注册手机号会被拒绝。

### 结论

- 短信 5 个 Secret 按“代码实际命名”均已齐全，可以发送；按“你列出的命名”缺 `TENCENT_SECRET_ID/KEY` 两项。
- `/api/public/auth/otp/send` 只服务 ERP 员工登录，不会创建消费者账号，也不会创建员工账号。

需要我下一步做什么？例如：把 Secret 命名统一为不带 `CLOUD` 的版本，或另行为消费者端建独立的 OTP 通道？
