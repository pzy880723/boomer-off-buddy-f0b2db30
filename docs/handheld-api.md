# 手持终端 RFID API

> ⚠️ **本 Markdown 仅作概要参考。完整字段、示例、在线调试请打开：**
>
> - 在线文档站：[`/api-docs`](https://boomer-off-buddy.lovable.app/api-docs)
> - OpenAPI 3.1 JSON：[`/api/public/handheld/openapi.json`](https://boomer-off-buddy.lovable.app/api/public/handheld/openapi.json)
>
> **唯一真源**：所有字段定义都在 `src/lib/handheld/schemas.ts`。
> 改字段流程：改 schema → `bun run sdk:check` 检测漂移 → `bun run sdk:gen` 重新生成 TS SDK + 快照 → 通知 APP 端拉新版 openapi.json。

---

## 基本信息

- 所有接口都在 `/api/public/handheld/*` 前缀下（**绕过站点登录**）。
- 鉴权：每个请求带 Header `X-Device-Token: <token>`。Token 由后台 **仓库管理 → 手持终端** 颁发。
- 统一响应：
  ```json
  { "ok": true,  "data": { ... } }
  { "ok": false, "error": "...", "code": "..." }
  ```
- 生产 Base URL：`https://boomer-off-buddy.lovable.app`
- 预览 Base URL：`https://project--2158bffa-7f82-4bc6-9df9-c59319d262f7-dev.lovable.app`

> ⚠️ ERP 改动后必须在 Lovable 顶部点 **Publish / Update**，否则生产站 `boomer-off-buddy.lovable.app/api/public/handheld/*` 仍是旧版本（症状：`openapi.json` 或新接口 404）。预览站会跟随每次保存自动更新。

## 接口清单

| 分组 | 方法 + 路径 | 说明 |
| ---- | ---------- | ---- |
| 鉴权 | `POST /auth/ping` | 设备心跳 / 当前库位信息 |
| 账号 | `POST /auth/login` | 操作员邮箱密码登录，返回 access_token + 可见库位 |
| 账号 | `GET /locations` `POST /location/switch` | 库位列表 / 切换当前库位 |
| SKU  | `GET /sku/by-epc?epc=` | 按 EPC 查询 |
| SKU  | `GET /sku/search?q=`  | 关键字搜索 |
| AI   | `POST /ai/recognize-item` | 拍照识别 → 商品结构化字段（Gemini 2.5 Pro）|
| AI   | `POST /ai/prepare-listing-image` | 原图 → 上架主图（Nano Banana 2）|
| 图片 | `POST /items/upload-image` | 申请直传 signed URL |
| 商品 | `POST /items/smart-create` | 智能上架（建 SKU + 入库存 + 可选入有赞队列）|
| 商品 | `GET /items/{id}/sync-status` | 查 SKU 在各有赞店铺的同步状态 |
| 入库 | `POST /inbound/scan`  | 扫码自动入库（仓库设备）|
| 盘点 | `POST /stocktake/open` `/stocktake/scan` `/stocktake/submit` | 盘点三步 |
| 调拨 | `POST /transfer/ship-scan` `/ship-confirm` `/receive-scan` `/receive-confirm` | 调拨四步 |
| RFID | `GET /rfid/{epc}` `POST /rfid/bind-item` `POST /rfid/transfer-location` | EPC 单点操作 |

> 鉴权说明：所有接口默认 `X-Device-Token`；走 `/auth/login` 后，APP 可附带 `X-Session-Token: <access_token>` 让 ERP 关联操作员审计。
>
> AI / 图片接口约定：图片永远以「签名 URL」形式在 APP 和 ERP 之间传递，不在 JSON body 里塞 base64。

详细 schema、示例、错误码请见在线文档。


## 给 APP 端：生成本地 SDK

TypeScript：
```bash
npx openapi-typescript \
  https://boomer-off-buddy.lovable.app/api/public/handheld/openapi.json \
  -o src/api/handheld.d.ts
```

Dart / Flutter：
```bash
openapi-generator-cli generate \
  -i https://boomer-off-buddy.lovable.app/api/public/handheld/openapi.json \
  -g dart-dio -o lib/api/handheld
```

Kotlin：
```bash
openapi-generator-cli generate \
  -i https://boomer-off-buddy.lovable.app/api/public/handheld/openapi.json \
  -g kotlin -o ./api/handheld
```

建议在 APP 仓库 CI 加一步：拉取线上 `openapi.json`，跟本地快照 hash 对比，不一致就阻塞发版。
