## 目标

把现有 `/api/public/handheld/*` 11 条接口收敛成 **OpenAPI 单一真源**：服务端 Zod schema 是唯一定义，文档站和 APP 端 SDK 都从它自动生成。改字段时只动一个地方，CI 防止漂移。

## 架构

```text
   [ src/lib/handheld/schemas.ts ]   ← 唯一真源（Zod）
            │
   ┌────────┼─────────────────────┐
   │        │                     │
   ▼        ▼                     ▼
路由 handler   生成 openapi.json    生成 APP SDK
(运行时校验)   (构建产物)          (TS/Dart/Kotlin)
   │              │
   │              ▼
   │     /api-docs (Scalar UI)
   │              ▲
   └─── 同源部署，APP 直接读 ────┘
```

## 实施步骤

### 1. 抽取 Zod schema 到 `src/lib/handheld/schemas.ts`

把现在散落在 11 个路由文件里的 `inputValidator` 全部收回这一个文件，按接口命名导出，例如：

- `InboundScanReq` / `InboundScanRes`
- `SkuByEpcReq` / `SkuByEpcRes`
- `StocktakeOpenReq` / `StocktakeOpenRes`
- `TransferShipScanReq` / `TransferShipScanRes`
- … 共 11 组

每个 schema 用 `.describe()` 标注字段含义、用 `.openapi({ example })` 标注示例（通过 `zod-openapi` 扩展）。路由文件改成 `import { InboundScanReq } from "@/lib/handheld/schemas"`，不再写本地 schema。

### 2. 用 `zod-openapi` 生成 OpenAPI 3.1 文档

新增 `src/lib/handheld/openapi.ts`：注册所有 schema + 路径，输出 `OpenAPIObject`。包含：

- 全局 `securitySchemes`：`X-Device-Token`（apiKey in header）
- 公共错误模型：`ErrorResponse { error: string, code?: string }`
- 每条路由的 method / path / 请求 / 响应 / 401·403·422 错误
- `servers`：production = `https://boomer-off-buddy.lovable.app`，preview = `https://project--2158bffa-7f82-4bc6-9df9-c59319d262f7-dev.lovable.app`

### 3. 在线文档站

- 新增路由 `src/routes/api/public/handheld/openapi.json.ts` —— 返回上一步生成的 JSON（公开、可缓存）。
- 新增路由 `src/routes/api-docs.tsx` —— 用 [Scalar API Reference](https://github.com/scalar/scalar)（比 Swagger UI 更现代、支持暗色主题，单个 React 组件挂载）渲染 `/api/public/handheld/openapi.json`。提供"复制 curl"、在线调试、按 Tag 分组（鉴权/入库/SKU/盘点/调拨）。
- 在登录后台的侧边栏加一个"API 文档"入口指向 `/api-docs`。

### 4. 自动生成 APP SDK

加 npm script `bun run sdk:gen`：

```text
openapi.json ──┐
               ├─► openapi-typescript    → sdk/ts/api.d.ts  (TS APP)
               ├─► openapi-generator-cli → sdk/dart/        (Flutter APP)
               └─► openapi-generator-cli → sdk/kotlin/      (Android 原生)
```

产物落在 `sdk/` 目录（gitignored 或单独仓库）。你 APP 工程里 `bun add` / `pub add` 引用即可，业务字段全部带类型。

### 5. CI 防漂移

加 `bun run sdk:check`：重新生成 openapi.json，跟仓库里上次提交的 `openapi.snapshot.json` diff。如果不一致就 fail，提示"接口契约变更，请同步运行 `bun run sdk:gen` 并通知 APP 端"。这是关键的"两端字段同步"保险。

### 6. 版本与兼容策略（给未来改字段用）

- URL 不带版本号；用 `info.version`（semver）+ 响应 header `X-API-Version` 标记。
- **加字段**：直接加，可选字段，老 APP 忽略 → 不算破坏。
- **改/删字段**：先在 schema 加 `.deprecated()`，文档站自动标红；过渡期同时返回新旧字段；APP 升级后下个版本删除。
- 破坏性变更（极少）：新增并行路由 `/v2/...`，老路由保留 ≥1 个 APP 版本周期。

### 7. 鉴权强化（顺便）

现在 `X-Device-Token` 是明文 UUID。建议同期：
- token 改 hash 存表（设备首次拿到后服务端只存 hash）。
- 加 `inv_handheld_devices.last_seen_at` 自动写入。
- 文档站的"试一试"用一个只读的演示 token，避免泄漏生产 token。

## 交付清单

新增文件：
- `src/lib/handheld/schemas.ts` —— 所有 Zod 真源
- `src/lib/handheld/openapi.ts` —— OpenAPI 文档生成器
- `src/routes/api/public/handheld/openapi.json.ts` —— 对外 JSON
- `src/routes/api-docs.tsx` —— Scalar 在线文档
- `scripts/gen-sdk.ts` —— 生成 TS/Dart/Kotlin SDK
- `scripts/check-openapi-drift.ts` —— CI 漂移检查
- `openapi.snapshot.json` —— 当前契约快照（提交到 git）

修改文件：
- `src/routes/api/public/handheld/*.ts` × 11 —— 改用 `@/lib/handheld/schemas` 共享 schema
- `docs/handheld-api.md` —— 改成一行：跳转 `/api-docs`
- `src/components/app-sidebar.tsx` —— 加一个"API 文档"入口
- `package.json` —— 加 `sdk:gen` / `sdk:check` script
- `bun add zod-openapi @scalar/api-reference-react openapi-typescript`

## 给你的建议

1. **OpenAPI 比手写 Markdown 强 10 倍**，但前提是 schema 真的成为唯一真源——路由文件不能再单独定义 Zod。第 1 步必须做彻底。
2. **不建议搞独立中转网关**：你的后端已经在 Cloudflare Workers 边缘上，再套一层只增加延迟、运维和鉴权同步成本。同源直出 + 在线文档 + 生成 SDK 已经完全覆盖你说的需求。
3. **APP 端配合**：建议 APP 仓库加一条 CI，定期拉 `https://你的域名/api/public/handheld/openapi.json` 跟本地 SDK 比 hash，不一致就阻塞发版——这样字段漂移在 APP 这一侧也兜得住。
4. 后续若要加"日本小包查询"或"商品列表只读 API"，只需要往 `schemas.ts` + `openapi.ts` 各加一段，文档站和 SDK 自动跟进。