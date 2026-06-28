# Handheld APP Onboarding — v1.2

> 所有接口都在 `/api/public/handheld/*` 前缀下（绕过站点登录）。
> OpenAPI: https://boomer-off-buddy.lovable.app/api/public/handheld/openapi.json
> Scalar UI: https://boomer-off-buddy.lovable.app/api-docs

## 1. 鉴权头

每个**写请求**必须同时带两个 header：

```
X-Device-Token: <设备 token>   # 后台「仓库管理 → 手持终端」颁发
X-Session-Token: <access_token> # 来自 /auth/login
```

- `X-Device-Token` 决定设备绑定的库位（warehouse / shop）。
- `X-Session-Token` 决定操作员审计（user_id 写入 movement note）。
- 只读接口（`auth/ping`, `sku/by-epc`, `sku/search`, `items/{id}`）允许只带 Device token。

## 2. Token 生命周期

- `auth/login` 返回 `access_token`（2 小时）+ `refresh_token`。
- access_token 过期前 5 分钟 APP 调 `auth/refresh` 换新。
- `auth/me` 用于启动期回填当前操作员；`auth/logout` 吊销 session。

## 3. 业务错误码（`code` 字段）

| code | 何时出现 | APP 建议处理 |
| --- | --- | --- |
| `unauthorized` | 缺少/无效 token | 跳登录页 |
| `unauthorized_location` | 设备库位不允许该操作 | 提示「请切换库位」 |
| `invalid_body` / `validation_error` | 入参缺字段 / 数量不一致 | toast 错误明细 |
| `not_found` | 资源不存在 | toast「未找到」 |
| `unlinked` | EPC 未绑定 SKU | 跳「认领 / 智能上架」流程 |
| `already_exists` | EPC 已绑到别的 SKU | 提示冲突，给「查看现有 SKU」按钮 |
| `transfer_required` | 物品当前在别的库位 | 引导创建调拨单 |
| `rate_limited` | 触发限流 | 退避重试 |
| `ai_credits_exhausted` | Lovable AI gateway 配额满 | 提示稍后再试 |
| `internal_error` | 服务端兜底 | toast，自动重试 1 次 |

> 注意 `unlinked` 会出现在 `/rfid/{epc}` 的 **200** 响应里（`ok:true, code:"unlinked"`），代表"扫到了但未绑定"；APP 直接按 code 分支即可。

## 4. 新增字段

- `inv_skus.barcode` — EAN-13，全局唯一，新建 SKU 时自动生成；`smart-create` 返回 `barcode` + `label.barcode`。
- `inv_skus.condition_grade` (复用 `grade` 列) — 枚举 `N | S | A | B | C | J`，APP 可直接读 `condition_grade`。
- `inv_unclaimed_epcs` — 裸 EPC 待认领队列，由 `/rfid/stock-in` 写入。

## 5. 图片上传两种模式

`POST /items/upload-image` 接受 `mode`:

- `signed`（默认）— 返回 Supabase PUT signed URL，APP 直传，省服务器带宽。
- `multipart` — 返回 ERP 中转 POST URL（`/items/upload-image/multipart`），APP 走 `multipart/form-data`（字段名 `file`），适合受限网络。

两种模式都返回同样的 7 天 signed `read_url`。

## 6. 推荐调用顺序

1. 启动：`auth/ping` 验设备 → 若 401 引导扫绑定二维码；
2. 登录：`auth/login` 拿 token → 存 keystore；
3. 进入扫描：每条 EPC 触发 `GET /rfid/{epc}`
   - `known:true` → 直接显示 SKU 卡；
   - `code:unlinked` → 跳「认领」或「智能上架」；
4. 智能上架：`ai/recognize-item` → `items/upload-image`（×N） → `ai/prepare-listing-image`（可选） → `items/smart-create`（带 `auto_push_youzan=false` 默认）；
5. 出现 `transfer_required` / `already_exists` → 进入调拨或冲突处理；
6. 后台静默：每 30 分钟 `auth/refresh`。

## 7. 字段同步约定

ERP `src/lib/handheld/schemas.ts` 是唯一真源。任何改动都会反映到 `/openapi.json`，APP 端通过 `bun run sdk:gen`（或 APP 自己的代码生成）拉取并重生成。
