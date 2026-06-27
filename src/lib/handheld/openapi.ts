/**
 * 从 schemas.ts 生成 OpenAPI 3.1 文档。
 * 任何字段变动，先改 schemas.ts，然后运行 `bun run sdk:check` 检查漂移。
 */
import { createDocument, type ZodOpenApiObject } from "zod-openapi";
import * as z from "zod";
import {
  AuthPingRes,
  ErrorResponse,
  InboundScanReq,
  InboundScanRes,
  SkuByEpcQuery,
  SkuByEpcRes,
  SkuSearchQuery,
  SkuSearchRes,
  StocktakeOpenReq,
  StocktakeOpenRes,
  StocktakeScanReq,
  StocktakeScanRes,
  StocktakeSubmitReq,
  StocktakeSubmitRes,
  TransferConfirmReq,
  TransferReceiveConfirmRes,
  TransferScanReq,
  TransferScanRes,
  TransferShipConfirmRes,
} from "./schemas";

const SECURITY = [{ DeviceToken: [] }];

const ERROR_RESPONSES = {
  "400": { description: "入参不合法", content: { "application/json": { schema: ErrorResponse } } },
  "401": { description: "缺少 / 无效 token", content: { "application/json": { schema: ErrorResponse } } },
  "403": { description: "设备被停用 / 库位/角色不匹配", content: { "application/json": { schema: ErrorResponse } } },
  "404": { description: "资源不存在", content: { "application/json": { schema: ErrorResponse } } },
  "409": { description: "状态冲突", content: { "application/json": { schema: ErrorResponse } } },
  "422": { description: "校验失败（数量不一致等）", content: { "application/json": { schema: ErrorResponse } } },
  "500": { description: "服务端错误", content: { "application/json": { schema: ErrorResponse } } },
};

const jsonBody = (schema: z.ZodType) => ({ content: { "application/json": { schema } } });
const jsonRes = (description: string, schema: z.ZodType) => ({
  description,
  content: { "application/json": { schema } },
});

const document: ZodOpenApiObject = {
  openapi: "3.1.0",
  info: {
    title: "Boomer Off — 手持终端 API",
    version: "1.0.0",
    description: `
所有接口都在 \`/api/public/handheld/*\` 前缀下（**绕过站点登录**）。

## 鉴权
每个请求必须带 HTTP Header：

\`\`\`
X-Device-Token: <设备 token>
\`\`\`

Token 由后台 **仓库管理 → 手持终端** 页面创建/复制。设备绑定的库位决定上报的目标位置。

## 统一响应

\`\`\`json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": "...", "...": "..." }
\`\`\`

## 字段同步约定

服务端的 Zod schema 是唯一真源（\`src/lib/handheld/schemas.ts\`）。
本文档 + APP 端 SDK 都从它生成。改字段流程：

1. 改 \`schemas.ts\`
2. 运行 \`bun run sdk:gen\` 生成新的 \`openapi.snapshot.json\` 和 TS 类型
3. APP 端拉取 \`/api/public/handheld/openapi.json\` 重新生成本地 SDK
`.trim(),
  },
  servers: [
    { url: "https://boomer-off-buddy.lovable.app", description: "Production" },
    {
      url: "https://project--2158bffa-7f82-4bc6-9df9-c59319d262f7-dev.lovable.app",
      description: "Preview",
    },
  ],
  components: {
    securitySchemes: {
      DeviceToken: {
        type: "apiKey",
        in: "header",
        name: "X-Device-Token",
        description: "设备 token，由后台「手持终端」页面颁发。",
      },
    },
  },
  security: SECURITY,
  tags: [
    { name: "鉴权", description: "设备心跳与登录信息" },
    { name: "SKU", description: "SKU 查询" },
    { name: "入库", description: "扫码自动入库（仅 warehouse 设备）" },
    { name: "盘点", description: "门店 / 仓库盘点流程" },
    { name: "调拨", description: "库位间调拨：发出方扫描 → 发出方确认 → 收货方扫描 → 收货方确认" },
  ],
  paths: {
    "/api/public/handheld/auth/ping": {
      post: {
        tags: ["鉴权"],
        summary: "设备心跳 / 登录信息",
        description: "APP 启动时调用一次。返回当前设备绑定的库位信息，决定界面是「仓库模式」还是「门店模式」。",
        responses: { "200": jsonRes("OK", AuthPingRes), ...ERROR_RESPONSES },
      },
      get: {
        tags: ["鉴权"],
        summary: "设备心跳 / 登录信息（GET 别名）",
        responses: { "200": jsonRes("OK", AuthPingRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/sku/by-epc": {
      get: {
        tags: ["SKU"],
        summary: "按 EPC 查询 SKU",
        description: "已知 EPC 返回 SKU + 当前库位；未知 EPC 返回是否在待认领队列。",
        requestParams: { query: SkuByEpcQuery },
        responses: { "200": jsonRes("OK", SkuByEpcRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/sku/search": {
      get: {
        tags: ["SKU"],
        summary: "搜索 SKU",
        description: "按 sku_code / name 模糊匹配，最多返回 20 条。",
        requestParams: { query: SkuSearchQuery },
        responses: { "200": jsonRes("OK", SkuSearchRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/inbound/scan": {
      post: {
        tags: ["入库"],
        summary: "扫码入库（仓库设备专用）",
        description:
          "对每个 EPC：已知 SKU 且未在当前仓库 → +1 movement；已在当前仓库 → duplicated；未知 → 进入「待认领 EPC」队列。一次最多 500 个 EPC。",
        requestBody: jsonBody(InboundScanReq),
        responses: { "200": jsonRes("OK", InboundScanRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/stocktake/open": {
      post: {
        tags: ["盘点"],
        summary: "打开盘点单",
        description: "同一库位同时只能有一个 scanning 盘点单。已存在会直接返回 reused: true。",
        requestBody: jsonBody(StocktakeOpenReq),
        responses: { "200": jsonRes("OK", StocktakeOpenRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/stocktake/scan": {
      post: {
        tags: ["盘点"],
        summary: "上传盘点扫描",
        description: "可多次调用，按 (stocktake_id, epc) 去重。未识别的 EPC 在返回里单独列出。",
        requestBody: jsonBody(StocktakeScanReq),
        responses: { "200": jsonRes("OK", StocktakeScanRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/stocktake/submit": {
      post: {
        tags: ["盘点"],
        summary: "提交盘点单",
        description: "聚合所有扫描，生成差异行，状态变 submitted。等待总部审核后才会修正库存。",
        requestBody: jsonBody(StocktakeSubmitReq),
        responses: { "200": jsonRes("OK", StocktakeSubmitRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/transfer/ship-scan": {
      post: {
        tags: ["调拨"],
        summary: "发出方扫描",
        description: "设备 location 必须 = transfer.from_location。",
        requestBody: jsonBody(TransferScanReq),
        responses: { "200": jsonRes("OK", TransferScanRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/transfer/ship-confirm": {
      post: {
        tags: ["调拨"],
        summary: "发出方确认",
        description:
          "校验每个 SKU 已扫数量 = 计划数量。成功后扣减发货方库存，EPC 状态变 in_transit，调拨单变 in_transit。",
        requestBody: jsonBody(TransferConfirmReq),
        responses: { "200": jsonRes("OK", TransferShipConfirmRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/transfer/receive-scan": {
      post: {
        tags: ["调拨"],
        summary: "收货方扫描",
        description: "设备 location 必须 = transfer.to_location。",
        requestBody: jsonBody(TransferScanReq),
        responses: { "200": jsonRes("OK", TransferScanRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/transfer/receive-confirm": {
      post: {
        tags: ["调拨"],
        summary: "收货方确认",
        description:
          "校验发出方扫的所有 EPC 都在收货扫描里。成功后增加收货方库存，EPC 状态变 in_stock 且 current_location_id 变更，调拨单变 received。",
        requestBody: jsonBody(TransferConfirmReq),
        responses: { "200": jsonRes("OK", TransferReceiveConfirmRes), ...ERROR_RESPONSES },
      },
    },
  },
};

let cached: ReturnType<typeof createDocument> | null = null;

export function buildHandheldOpenApi() {
  if (!cached) cached = createDocument(document);
  return cached;
}
