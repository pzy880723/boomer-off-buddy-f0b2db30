/**
 * 从 schemas.ts 生成 OpenAPI 3.1 文档。
 * 任何字段变动，先改 schemas.ts，然后运行 `bun run sdk:check` 检查漂移。
 */
import { createDocument, type ZodOpenApiObject } from "zod-openapi";
import * as z from "zod";
import {
  AiListingImageReq,
  AiListingImageRes,
  AiRecognizeReq,
  AiRecognizeRes,
  AuthPingRes,
  ErrorResponse,
  InboundScanReq,
  InboundScanRes,
  LocationsRes,
  LocationSwitchReq,
  LocationSwitchRes,
  LoginReq,
  LoginRes,
  RfidBindReq,
  RfidBindRes,
  RfidTransferReq,
  RfidTransferRes,
  SkuByEpcQuery,
  SkuByEpcRes,
  SkuSearchQuery,
  SkuSearchRes,
  SmartCreateReq,
  SmartCreateRes,
  StocktakeOpenReq,
  StocktakeOpenRes,
  StocktakeScanReq,
  StocktakeScanRes,
  StocktakeSubmitReq,
  StocktakeSubmitRes,
  SyncStatusRes,
  TransferConfirmReq,
  TransferReceiveConfirmRes,
  TransferScanReq,
  TransferScanRes,
  TransferShipConfirmRes,
  UploadImageReq,
  UploadImageRes,
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
    { name: "账号", description: "操作员登录、可见库位、当前库位切换（v1.1+）" },
    { name: "SKU", description: "SKU 查询" },
    { name: "AI", description: "拍照识别商品 + 出上架主图（v1.1+）" },
    { name: "图片", description: "签名上传图片到 Storage（v1.1+）" },
    { name: "商品", description: "智能上架 + 有赞同步状态（v1.1+）" },
    { name: "入库", description: "扫码自动入库（仅 warehouse 设备）" },
    { name: "盘点", description: "门店 / 仓库盘点流程" },
    { name: "调拨", description: "库位间调拨：发出方扫描 → 发出方确认 → 收货方扫描 → 收货方确认" },
    { name: "RFID", description: "EPC 单点操作（v1.1+）" },
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
    "/api/public/handheld/auth/login": {
      post: {
        tags: ["账号"],

        summary: "操作员登录（邮箱 + 密码）",
        description:
          "复用 ERP 后台 Supabase 账号体系。返回 access_token，APP 后续可放到 `X-Session-Token` Header 让 ERP 关联操作员；同时返回所有 active 库位列表，APP 让店员选当前操作库位。",
        requestBody: jsonBody(LoginReq),
        responses: { "200": jsonRes("OK", LoginRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/locations": {
      get: {
        tags: ["账号"],
        summary: "列出所有 active 库位",
        responses: { "200": jsonRes("OK", LocationsRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/location/switch": {
      post: {
        tags: ["账号"],
        summary: "切换当前设备绑定的库位",
        description: "更新 `inv_handheld_devices.default_location_id`。",
        requestBody: jsonBody(LocationSwitchReq),
        responses: { "200": jsonRes("OK", LocationSwitchRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/ai/recognize-item": {
      post: {
        tags: ["AI"],
        summary: "拍照识别商品 → 结构化字段",
        description:
          "多模态识别。默认模型 `google/gemini-2.5-pro`，走 Lovable AI Gateway。返回 name / category / brand / era / condition_grade / description / suggested_price_cny。不确定的字段为 null。",
        requestBody: jsonBody(AiRecognizeReq),
        responses: { "200": jsonRes("OK", AiRecognizeRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/ai/prepare-listing-image": {
      post: {
        tags: ["AI"],
        summary: "原图 → 上架主图",
        description:
          "默认模型 `google/gemini-3.1-flash-image`（Nano Banana 2）。只做角度/裁切/底色/光线修正，不改商品本体。生成后写入 `sku-listing` 私桶并返回 7 天 signed URL。",
        requestBody: jsonBody(AiListingImageReq),
        responses: { "200": jsonRes("OK", AiListingImageRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/items/upload-image": {
      post: {
        tags: ["图片"],
        summary: "申请图片直传 signed URL",
        description:
          "APP 先调本接口拿到 `upload_url` + `headers`，再用 `PUT` 直接把图片传到 Storage，避免大图穿过 ERP。返回的 `read_url` 是 7 天 signed GET URL，可直接用于 smart-create。",
        requestBody: jsonBody(UploadImageReq),
        responses: { "200": jsonRes("OK", UploadImageRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/items/smart-create": {
      post: {
        tags: ["商品"],
        summary: "智能上架（建 SKU + 入库存 + 绑 EPC + 入有赞队列）",
        description:
          "如果已经存在 (category, price_tier, name) 完全相同的 SKU，会复用并 +1；否则新建。`epcs` 可选，传了就一并绑定到这个 SKU。`auto_push_youzan` 默认 false，对齐 ERP 现行「手动推送 + 人工绑定」策略；true 时若 SKU 已有有赞绑定则入 `youzan_stock_sync_queue`，否则返回 `unlinked`。返回的 `label` 字段供 APP 自渲染打印。",
        requestBody: jsonBody(SmartCreateReq),
        responses: { "200": jsonRes("OK", SmartCreateRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/items/{id}/sync-status": {
      get: {
        tags: ["商品"],
        summary: "查 SKU 在各有赞店铺的同步状态",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        responses: { "200": jsonRes("OK", SyncStatusRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/rfid/{epc}": {
      get: {
        tags: ["RFID"],
        summary: "按 EPC 查 SKU + 当前库位（等价 sku/by-epc，URL 风格不同）",
        requestParams: { path: z.object({ epc: z.string() }) },
        responses: { "200": jsonRes("OK", SkuByEpcRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/rfid/bind-item": {
      post: {
        tags: ["RFID"],
        summary: "把单个 EPC 绑到指定 SKU 并入库 +1",
        description:
          "用于「待认领 EPC」现场认领，或新打的标签直接绑到已有 SKU。会同时从 `inv_unclaimed_epcs` 移除。",
        requestBody: jsonBody(RfidBindReq),
        responses: { "200": jsonRes("OK", RfidBindRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/rfid/transfer-location": {
      post: {
        tags: ["RFID"],
        summary: "把单个 EPC 直接换库位（现场纠错）",
        description:
          "对应「这件东西被人挪到别的库位但没走调拨单」的情况。生成成对的 -1 / +1 movement。批量调拨请用 `transfer/*` 系列。",
        requestBody: jsonBody(RfidTransferReq),
        responses: { "200": jsonRes("OK", RfidTransferRes), ...ERROR_RESPONSES },
      },
    },
  },
};

let cached: ReturnType<typeof createDocument> | null = null;

export function buildHandheldOpenApi() {
  if (!cached) cached = createDocument(document);
  return cached;
}

