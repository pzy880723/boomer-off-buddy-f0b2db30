## 目标

今后凡是涉及 APP（Codex 端）需要配合的改动，每轮结束都额外附一段「**给 Codex 的指令**」，让你一键复制粘贴即可派活。

## 触发条件（满足任一即附）

- 本轮改动了 `/api/public/**` 接口、字段、返回结构、错误码
- 本轮改动了 OpenAPI（`openapi.snapshot.json` / `src/lib/handheld/**`）
- 本轮改动了 APP 端会用到的认证 / OTP / bootstrap / 设备绑定 / 库位 / RFID / AI 流程
- 本轮发布了新版本（v1.x）需要 APP 跟随升级
- 本轮调整了业务数据口径，APP 展示需要跟着改

纯 ERP 前端 / PC 端 / 数据库内部清理 → 不附。

## 指令块格式（固定模板）

每段以独立代码块输出，方便整段复制：

```text
【给 Codex 的指令 · YYYY-MM-DD · 第N条】

背景：<这轮 Lovable 这边做了什么、为什么 APP 要改>

请在 APP 端执行：
1. <具体动作，含接口路径 / 字段名 / 错误码>
2. <…>

接口契约：
- POST <path>
  Request: { … }
  Response: { ok, data: { … } }
  错误码：<code> → <UI 文案>

验收：
- <可观察的成功标准，例如"输入手机号点获取验证码 → 看到 toast 'ttl 300'"></>
```

## 落地方式

- 写入项目记忆 `mem://preferences/codex-handoff`，列入 Core，让后续每轮自动遵守。
- 历史 `.lovable/plan.md` 里的 Codex 协作清单保留，但今后以"每轮即时指令"为主，不再让你回去翻长文档。

## 本轮（已完成的库位清洗 + 自动绑定）对应的 Codex 指令草稿

进入 build 模式后我会先把上面那条记忆写好，并补发一条对应本轮库位改动的 Codex 指令给你，确认这个交付格式 OK 后正式沿用。
