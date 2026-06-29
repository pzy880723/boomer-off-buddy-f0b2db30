## 诊断

代码侧检查结果（仓库 = 最新预览构建）：

- `src/routes/api/public/auth/otp.send.ts` 和 `otp.verify.ts` 都存在，且已经在 `src/routeTree.gen.ts` 里注册为 server route（POST + OPTIONS）。
- `src/lib/handheld/openapi.ts` 和 `openapi.snapshot.json` 都已经升到 `version: 1.4.0`，并且包含 `/api/public/auth/otp/send` 与 `/api/public/auth/otp/verify` 两个路径。

线上现象：

- `https://boomer-off-buddy.lovable.app/api/public/handheld/openapi.json` 仍是 `1.0.0`，没有 otp 路径。
- `POST /api/public/auth/otp/send` 返回 500 + `"Only HTML requests are supported here"`。这是 TanStack Start 在「该 URL 没有匹配的 server handler」时的 SSR 兜底响应——也就是说生产构建里根本还没有这两个 server route 文件。

结论：**OTP 接口的代码已经写好，但还没有发布到 `boomer-off-buddy.lovable.app`**。`Codex` 看到的就是上一版生产构建（v1.0.0 时期）。Codex 那侧不需要再改 APP，等这次发布完，APP 现有的请求路径就能直接生效。

另外说明：APP 端记录的 `/api/public/handheld/auth/otp/send` 是**错的**，OTP 接口不在 handheld 子路径下，正确路径就是：

- `POST /api/public/auth/otp/send`
- `POST /api/public/auth/otp/verify`

## 执行步骤

1. 切到 build 模式后，调用发布工具把当前预览构建推到生产 (`boomer-off-buddy.lovable.app`)，不需要任何代码改动。
2. 发布完成后，自行回归校验：
   - `GET /api/public/handheld/openapi.json` → `version` 应为 `1.4.0`，`paths` 里能搜到 `/api/public/auth/otp/send` 与 `/auth/otp/verify`。
   - `POST /api/public/auth/otp/send`，body `{"phone":"13800001111","purpose":"login"}` → 返回 `{"ok":true,"data":{"ttl":300}}`（或 `429 rate_limited`，说明已经走到限流逻辑，也算正常）。
   - `POST /api/public/auth/otp/verify`，body `{"phone":"13800001111","code":"000000"}` → 返回 `{"ok":false,"error":"...","code":"otp_not_found"|"otp_invalid"}`，证明 JSON 通道工作正常。
3. 把校验结果反馈给 Codex，并提醒：APP 端要把 `/api/public/handheld/auth/otp/send` 改成 `/api/public/auth/otp/send`（去掉 `/handheld`）。

## 不做的事

- 不修改 `otp.send.ts` / `otp.verify.ts`：代码已经返回符合契约的 JSON（`ok: true, data: { ttl: 300 }`），问题是发布而非实现。
- 不动 OpenAPI 快照：本地已是 1.4.0，发布后线上会同步。
