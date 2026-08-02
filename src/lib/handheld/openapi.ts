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
  AuthMeRes,
  AuthPingRes,
  AuthRefreshReq,
  AuthRefreshRes,
  AttachImagesReq,
  AttachImagesRes,
  LabelTemplatesRes,
  LabelTemplateCreateReq,
  LabelTemplateUpdateReq,
  LabelTemplateRes,
  LabelTemplateDeleteRes,
  LabelTemplateSetDefaultRes,
  BootstrapReq,
  BootstrapRes,
  OtpSendReq,
  OtpSendRes,
  OtpVerifyReq,
  OtpVerifyWebRes,
  DiagReportReq,
  DiagReportRes,
  ErrorResponse,
  HandheldErrorCode,
  InboundScanReq,
  InboundScanRes,
  LocationsRes,
  LocationSwitchReq,
  LocationSwitchRes,
  LoginReq,
  LoginRes,
  NotificationsSinceQuery,
  NotificationsSinceRes,
  RfidBatchStockInReq,
  RfidBatchStockInRes,
  RfidBindReq,
  RfidBindRes,
  RfidStockInReq,
  RfidStockInRes,
  RfidTransferReq,
  RfidTransferRes,
  SkuByEpcQuery,
  SkuByEpcRes,
  SkuDetailRes,
  SetListingStatusReq,
  SetListingStatusRes,
  RestockReq,
  RestockRes,
  SkuSearchQuery,
  SkuSearchRes,
  ProductLookupQuery,
  ProductLookupRes,
  ProductsQuery,
  ProductsRes,
  GlobalStockQuery,
  GlobalStockRes,
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
  SignReadUrlReq,
  SignReadUrlRes,
  UploadImageReq,
  UploadImageRes,
  ParcelListQuery,
  ParcelListRes,
  ParcelCountsRes,
  ParcelDetailRes,
  ParcelPackPiecesReq,
  ParcelPackPiecesRes,
  ParcelEstimateRes,
  StorefrontCreateOrderReq,
  StorefrontCreateOrderRes,
  StorefrontErrorResponse,
  StorefrontOrderDetailRes,
  StorefrontOrdersRes,
  StorefrontProductRes,
  StorefrontProductsQuery,
  StorefrontProductsRes,
  StorefrontTaxonomyQuery,
  StorefrontTaxonomyRes,
} from "./schemas";

const SECURITY = [{ DeviceToken: [], SessionToken: [] }];

const ERROR_RESPONSES = {
  "400": {
    description: "入参不合法（code: invalid_body / validation_error）",
    content: { "application/json": { schema: ErrorResponse } },
  },
  "401": {
    description: "缺少 / 无效 token（code: unauthorized）",
    content: { "application/json": { schema: ErrorResponse } },
  },
  "403": {
    description: "设备被停用 / 库位/角色不匹配（code: unauthorized_location）",
    content: { "application/json": { schema: ErrorResponse } },
  },
  "404": {
    description: "资源不存在（code: not_found / unlinked）",
    content: { "application/json": { schema: ErrorResponse } },
  },
  "409": {
    description: "状态冲突（code: already_exists / transfer_required）",
    content: { "application/json": { schema: ErrorResponse } },
  },
  "422": {
    description: "校验失败（数量不一致等，code: validation_error）",
    content: { "application/json": { schema: ErrorResponse } },
  },
  "429": {
    description: "限流（code: rate_limited / ai_credits_exhausted）",
    content: { "application/json": { schema: ErrorResponse } },
  },
  "500": {
    description: "服务端错误（code: internal_error）",
    content: { "application/json": { schema: ErrorResponse } },
  },
};

const STOREFRONT_ERROR_RESPONSES = {
  "400": {
    description: "请求参数错误",
    content: { "application/json": { schema: StorefrontErrorResponse } },
  },
  "401": {
    description: "商城用户未登录或会话失效",
    content: { "application/json": { schema: StorefrontErrorResponse } },
  },
  "404": {
    description: "商品或订单不存在",
    content: { "application/json": { schema: StorefrontErrorResponse } },
  },
  "409": {
    description: "库存冲突或商品不可售",
    content: { "application/json": { schema: StorefrontErrorResponse } },
  },
  "422": {
    description: "业务规则校验失败",
    content: { "application/json": { schema: StorefrontErrorResponse } },
  },
  "500": {
    description: "服务端错误",
    content: { "application/json": { schema: StorefrontErrorResponse } },
  },
};

const StorefrontCreatePaymentReq = z.object({
  order_id: z.string().uuid(),
  provider: z.enum(["wechat", "alipay"]),
  client_context: z
    .object({
      platform: z.enum(["app", "miniapp", "web"]),
      openid: z.string().min(1).max(200).optional(),
      return_url: z.string().url().optional(),
    })
    .default({ platform: "app" }),
});

const StorefrontCreatePaymentRes = z.object({
  ok: z.literal(true),
  data: z.object({
    payment: z.object({
      id: z.string().uuid(),
      order_id: z.string().uuid(),
      provider: z.enum(["wechat", "alipay"]),
      status: z.string(),
      amount: z.number(),
      currency: z.string(),
      provider_transaction_id: z.string(),
      created_at: z.string(),
    }),
    payment_payload: z.record(z.string(), z.unknown()),
    expires_at: z.string(),
  }),
});

const StorefrontPaymentCallbackReq = z.object({
  event_id: z.string().min(1).max(200),
  event_type: z.string().min(1).max(100),
  transaction_id: z.string().min(1).max(200),
  merchant_order_no: z.string().min(1).max(100),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  amount: z.number().positive(),
  paid_at: z.string().datetime().optional(),
  failure_code: z.string().max(100).optional(),
  failure_message: z.string().max(500).optional(),
});

const StorefrontPaymentCallbackRes = z.object({
  ok: z.literal(true),
  replayed: z.boolean().optional(),
});

const jsonBody = (schema: z.ZodType) => ({ content: { "application/json": { schema } } });
const jsonRes = (description: string, schema: z.ZodType) => ({
  description,
  content: { "application/json": { schema } },
});

const document: ZodOpenApiObject = {
  openapi: "3.1.0",
  info: {
    title: "Boomer Off — Public API",
    version: "1.10.0",
    description: `
本文档覆盖：

- \`/api/public/handheld/*\`：ERP 手持终端接口。
- \`/api/public/storefront/*\`：自营商城商品、分类和订单接口。

## 手持终端鉴权
手持终端业务请求带：

\`\`\`
X-Device-Token: <设备 token>
X-Session-Token: <操作员 session token>
\`\`\`

## 商城鉴权

- 商品和分类接口公开读取。
- 订单接口使用 \`Authorization: Bearer <腾讯云消费者 JWT>\`。
- 消费者 JWT 由独立身份服务签发，ERP 通过 JWKS 验签，不复用 ERP 员工账号。
- 创建订单和支付还必须带 \`Idempotency-Key\`。

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
    schemas: {
      HandheldErrorCode,
    },
    securitySchemes: {
      DeviceToken: {
        type: "apiKey",
        in: "header",
        name: "X-Device-Token",
        description: "设备 token，由后台「手持终端」页面颁发。所有写请求必须带。",
      },
      SessionToken: {
        type: "apiKey",
        in: "header",
        name: "X-Session-Token",
        description:
          "操作员 Supabase access_token（来自 /auth/login）。所有写请求 + AI 请求都必须带；ERP 会按此关联操作员审计。",
      },
      StorefrontBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "腾讯云消费者身份服务签发的 RS256 JWT。ERP 使用 CONSUMER_AUTH_JWKS_URL 验签。",
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
    { name: "通知", description: "APP 主动轮询的事件（v1.2+）" },
    { name: "诊断", description: "APP 上报 crash / 网络错误 / 设备状态（v1.2+）" },
    { name: "日本小包", description: "只读；仅 super_admin 可用（v1.6+）" },
    { name: "商城商品", description: "消费者商城公开商品与统一分类" },
    { name: "商城订单", description: "消费者商城订单；需要 Bearer 用户会话" },
    { name: "商城支付", description: "消费者支付发起与支付网关签名回调" },
  ],

  paths: {
    "/api/public/storefront/products": {
      get: {
        tags: ["商城商品"],
        summary: "商城商品列表",
        description:
          "只返回已发布且当前门店库存大于 0 的商品。分类、品牌、facet 与 ERP 主数据共用同一套编码。",
        security: [],
        requestParams: { query: StorefrontProductsQuery },
        responses: {
          "200": jsonRes("OK", StorefrontProductsRes),
          ...STOREFRONT_ERROR_RESPONSES,
        },
      },
    },
    "/api/public/storefront/products/{id}": {
      get: {
        tags: ["商城商品"],
        summary: "商城商品详情",
        security: [],
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        responses: {
          "200": jsonRes("OK", StorefrontProductRes),
          ...STOREFRONT_ERROR_RESPONSES,
        },
      },
    },
    "/api/public/storefront/taxonomy": {
      get: {
        tags: ["商城商品"],
        summary: "商城分类、品牌与筛选维度",
        description:
          "返回 ERP 当前启用的主分类/叶子分类、品牌和 facet；传 primary_category 时按适用范围过滤。",
        security: [],
        requestParams: { query: StorefrontTaxonomyQuery },
        responses: {
          "200": jsonRes("OK", StorefrontTaxonomyRes),
          ...STOREFRONT_ERROR_RESPONSES,
        },
      },
    },
    "/api/public/storefront/orders": {
      get: {
        tags: ["商城订单"],
        summary: "当前用户订单列表",
        security: [{ StorefrontBearer: [] }],
        responses: {
          "200": jsonRes("OK", StorefrontOrdersRes),
          ...STOREFRONT_ERROR_RESPONSES,
        },
      },
      post: {
        tags: ["商城订单"],
        summary: "创建商城订单并锁定库存",
        security: [{ StorefrontBearer: [] }],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "同一次下单重试必须复用相同值。",
          },
        ],
        requestBody: jsonBody(StorefrontCreateOrderReq),
        responses: {
          "201": jsonRes("Created", StorefrontCreateOrderRes),
          ...STOREFRONT_ERROR_RESPONSES,
        },
      },
    },
    "/api/public/storefront/orders/{id}": {
      get: {
        tags: ["商城订单"],
        summary: "当前用户订单详情",
        security: [{ StorefrontBearer: [] }],
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        responses: {
          "200": jsonRes("OK", StorefrontOrderDetailRes),
          ...STOREFRONT_ERROR_RESPONSES,
        },
      },
    },
    "/api/public/storefront/payments": {
      post: {
        tags: ["商城支付"],
        summary: "为商城订单创建支付",
        description:
          "通过服务端支付网关适配器创建微信或支付宝支付。APP 只消费 payment_payload，不持有商户密钥。",
        security: [{ StorefrontBearer: [] }],
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "同一次支付发起重试必须复用相同值。",
          },
        ],
        requestBody: jsonBody(StorefrontCreatePaymentReq),
        responses: {
          "201": jsonRes("Created", StorefrontCreatePaymentRes),
          "502": {
            description: "支付网关响应失败",
            content: { "application/json": { schema: StorefrontErrorResponse } },
          },
          "503": {
            description: "支付网关尚未配置",
            content: { "application/json": { schema: StorefrontErrorResponse } },
          },
          ...STOREFRONT_ERROR_RESPONSES,
        },
      },
    },
    "/api/public/storefront/payments/callback/{provider}": {
      post: {
        tags: ["商城支付"],
        summary: "支付网关签名回调",
        description:
          "支付网关调用。服务端校验原始请求体的 HMAC-SHA256 签名、金额及事件幂等后完成订单。",
        security: [],
        requestParams: {
          path: z.object({ provider: z.enum(["wechat", "alipay"]) }),
        },
        parameters: [
          {
            name: "X-Payment-Signature",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "原始 JSON 请求体的 HMAC-SHA256 十六进制签名。",
          },
        ],
        requestBody: jsonBody(StorefrontPaymentCallbackReq),
        responses: {
          "200": jsonRes("OK", StorefrontPaymentCallbackRes),
          "503": {
            description: "支付回调密钥尚未配置",
            content: { "application/json": { schema: StorefrontErrorResponse } },
          },
          ...STOREFRONT_ERROR_RESPONSES,
        },
      },
    },
    "/api/public/handheld/auth/ping": {
      post: {
        tags: ["鉴权"],
        summary: "设备心跳 / 登录信息",
        description:
          "APP 启动时调用一次。返回当前设备绑定的库位信息，决定界面是「仓库模式」还是「门店模式」。",
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
        description:
          "按 sku_code / name 模糊匹配，最多返回 20 条；返回 image_url / image_paths / images，APP 可直接展示主图。",
        requestParams: { query: SkuSearchQuery },
        responses: { "200": jsonRes("OK", SkuSearchRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/products": {
      get: {
        tags: ["商品"],
        summary: "商品总账列表（含多库位库存与图片）",
        description:
          "APP 商品页用。支持 q/type/scope/location_id/category/has_image/sort/page/page_size。默认排序 custom → bundle → standard 再按 updated_at 倒序；也支持 sort=created_desc/created_asc/price_desc/price_asc/stock_desc。响应包含 counts（各 type 角标，受 q/category 影响但不受 type 影响）和 items[].editable（standard 恒为 false）。",
        requestParams: { query: ProductsQuery },
        responses: { "200": jsonRes("OK", ProductsRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/global-stock": {
      get: {
        tags: ["商品"],
        summary: "全局库存矩阵（总仓账号专用）",
        description:
          "仅 super_admin / hq_operator 可用；其他角色返回 403。按 type Tab 返回：locations 全量、items[].stocks 是 {location_id: qty} 字典、summary 汇总（sku_count/total_qty/out_of_stock/low_stock）。支持 q/category/stock_state(all|out|low)/low_threshold/page/page_size。",
        requestParams: { query: GlobalStockQuery },
        responses: { "200": jsonRes("OK", GlobalStockRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/products/lookup": {
      get: {
        tags: ["商品"],
        summary: "扫码或关键词查商品详情",
        description:
          "优先用 code 匹配 barcode / sku_code / EPC / QR JSON；兼容 q 关键词，返回第一条命中商品。返回结构与 /products.items[] 同构。",
        requestParams: { query: ProductLookupQuery },
        responses: { "200": jsonRes("OK", ProductLookupRes), ...ERROR_RESPONSES },
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
    "/api/public/handheld/auth/bootstrap": {
      post: {
        tags: ["账号"],
        summary: "APP 自助引导：登录即拿 device_token + access_token（v1.3）",
        description:
          "**不需要 X-Device-Token**。APP 首装时生成稳定 `install_id` 持久化，然后用 ERP 邮箱/手机号 + 密码调本接口。服务端按 (owner_user_id, install_id) upsert 设备，自动颁发 device_token；首登设备的 `default_location_id` 为 null，APP 再调 `/location/switch` 让用户选库位。",
        security: [],
        requestBody: jsonBody(BootstrapReq),
        responses: { "200": jsonRes("OK", BootstrapRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/auth/login": {
      post: {
        tags: ["账号"],

        summary: "操作员登录（旧：需要后台预创建设备 + X-Device-Token）",
        description:
          "保留兼容。新接入请用 `/auth/bootstrap`，一次登录即可同时拿 device_token + access_token，无需后台手动建设备。",
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
          "APP 先调本接口拿到 `upload_url` + `headers`，再用 `PUT` 直接把图片传到 Storage，避免大图穿过 ERP。`read_url` 上传前永远是 null（Storage 的 createSignedUrl 要求对象已存在），上传完成后调 POST /items/sign-read-url 拿 7 天 signed GET URL。",
        requestBody: jsonBody(UploadImageReq),
        responses: { "200": jsonRes("OK", UploadImageRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/items/sign-read-url": {
      post: {
        tags: ["图片"],
        summary: "为已上传对象签发 read URL",
        description: "在 /items/upload-image 直传成功后调用，返回 signed GET URL（默认 7 天）。",
        requestBody: jsonBody(SignReadUrlReq),
        responses: { "200": jsonRes("OK", SignReadUrlRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/items/smart-create": {
      post: {
        tags: ["商品"],
        summary: "智能上架（建 SKU + 入库存 + 绑 EPC + 入有赞队列）",
        description:
          "如果已经存在 (category, price_tier, name) 完全相同的 SKU，会复用并 +1；否则新建。`epcs` 可选，传了就一并绑定到这个 SKU。`auto_push_youzan` 默认 false；true 时会把商品发布到所选门店库位绑定的有赞分店，并登记库存同步任务。仓库库位不会自动发布到任意门店。返回的 `label` 字段供 APP 自渲染打印。",
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
    "/api/public/handheld/rfid/stock-in": {
      post: {
        tags: ["RFID"],
        summary: "裸 EPC 入库到待认领队列",
        description:
          "扫到一批未绑定 SKU 的标签时调用。已绑定的 EPC 会在 `already_bound` 里返回，APP 应改走 inbound/scan 或 transfer-location。",
        requestBody: jsonBody(RfidStockInReq),
        responses: { "200": jsonRes("OK", RfidStockInRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/auth/refresh": {
      post: {
        tags: ["账号"],
        summary: "用 refresh_token 换新的 access_token",
        description: "access_token 有效期 2 小时；refresh_token 由 Supabase 维护。",
        requestBody: jsonBody(AuthRefreshReq),
        responses: { "200": jsonRes("OK", AuthRefreshRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/auth/me": {
      get: {
        tags: ["账号"],
        summary: "当前设备 + 操作员上下文",
        description: "未带 X-Session-Token 时 user=null，APP 可以提示重新登录。",
        responses: { "200": jsonRes("OK", AuthMeRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/auth/logout": {
      post: {
        tags: ["账号"],
        summary: "登出当前操作员（吊销 session）",
        responses: { "200": jsonRes("OK", AuthPingRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/items/{id}": {
      get: {
        tags: ["商品"],
        summary: "SKU 详情（含 barcode / condition_grade / 多库位库存）",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        responses: { "200": jsonRes("OK", SkuDetailRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/items/{id}/set-status": {
      post: {
        tags: ["商品"],
        summary: "上架 / 下架商品（对齐有赞 is_display）",
        description:
          "设置 inv_skus.is_display；true=上架（销售中或已售罄由库存派生），false=下架（仓库中）。同时入队 youzan_stock_sync_queue.push_is_display 供有赞侧上/下架。权限：super_admin | hq_operator | shop_manager。",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        requestBody: jsonBody(SetListingStatusReq),
        responses: { "200": jsonRes("OK", SetListingStatusRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/items/{id}/restock": {
      post: {
        tags: ["商品"],
        summary: "已售罄补货 + 打印标签",
        description:
          "对已售罄商品的到货补录：写入库存流水（ref_type=handheld_restock），并可选生成 inv_label_batches 打印批次；APP 收到 label_batch 后调本地打印驱动，按 print_payload × qty 打印。",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        requestBody: jsonBody(RestockReq),
        responses: { "200": jsonRes("OK", RestockRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/items/{id}/attach-images": {
      post: {
        tags: ["图片"],
        summary: "给已有 SKU 追加图片（不改库存）",
        description:
          "历史无图商品补图用。APP 上传图片后把 image_storage_paths 传进来；服务端追加到 inv_skus.image_paths、去重并返回签好的 read URL。不会 +1 库存。",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        requestBody: jsonBody(AttachImagesReq),
        responses: { "200": jsonRes("OK", AttachImagesRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/rfid/batch-stock-in": {
      post: {
        tags: ["RFID"],
        summary: "批量裸 EPC 入库（v1.2 离线幂等）",
        description:
          "APP 离线时把多次扫描攒成一批补交；每条 op 必须带 `client_op_id`，服务端按 (device, client_op_id) 回放，永远幂等。每条结果都会带 `replayed: bool`。",
        requestBody: jsonBody(RfidBatchStockInReq),
        responses: { "200": jsonRes("OK", RfidBatchStockInRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/notifications/since": {
      get: {
        tags: ["通知"],
        summary: "拉取自 `ts` 之后的通知（v1.2 轮询模式）",
        description:
          "推荐 APP 每 30s 轮询一次；首次不传 `ts`，之后用上次响应的 `server_ts`。只下发给本设备 / 本库位 / 全局的事件。",
        requestParams: { query: NotificationsSinceQuery },
        responses: { "200": jsonRes("OK", NotificationsSinceRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/diag/report": {
      post: {
        tags: ["诊断"],
        summary: "上报 APP 端 crash / 网络错误 / 设备状态（v1.2）",
        description: "请勿在 payload 里上传 token 原文；ERP 会按 device + user 关联审计。",
        requestBody: jsonBody(DiagReportReq),
        responses: { "200": jsonRes("OK", DiagReportRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/auth/otp/send": {
      post: {
        tags: ["账号"],
        summary: "发送手机验证码（v1.4）",
        description:
          "**公开接口**，不需要任何 token。同手机号 60 秒内最多 1 次、10 分钟内最多 5 次；单 IP 每小时最多 20 次。短信通道：腾讯云 SMS。",
        security: [],
        requestBody: jsonBody(OtpSendReq),
        responses: { "200": jsonRes("OK", OtpSendRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/auth/otp/verify": {
      post: {
        tags: ["账号"],
        summary: "验证验证码并登录（v1.4）",
        description:
          "**公开接口**，不需要任何 token。\n\n- **Web 模式**：只传 `phone` + `code`，返回 `{ session, user }`，前端用 `supabase.auth.setSession()` 落地。\n- **APP 模式**：额外带 `install_id` / `device_label` / `capabilities`，服务端 upsert 设备并返回 **完整 BootstrapRes**（device_token + access_token + session_token + refresh_token + device + user + locations），一步登录到位。\n\n用户必须已经被管理员添加到 ERP；本接口不会自动注册新账号。",
        security: [],
        requestBody: jsonBody(OtpVerifyReq),
        responses: {
          "200": jsonRes("Web 模式 OK", OtpVerifyWebRes),
          ...ERROR_RESPONSES,
        },
      },
    },
    "/api/public/handheld/label-templates": {
      get: {
        tags: ["标签模板"],
        summary: "列出所有标签模板（v1.5）",
        description:
          "返回全部模板 + 默认模板 id；`can_manage=true` 表示当前登录账号为总部权限，可增删改。任何登录设备都可读取，用于本地缓存。",
        responses: { "200": jsonRes("OK", LabelTemplatesRes), ...ERROR_RESPONSES },
      },
      post: {
        tags: ["标签模板"],
        summary: "新建标签模板（HQ）",
        description:
          "仅总部权限（super_admin / hq_operator）可用。传 `is_default:true` 会自动把其它模板取消默认。",
        requestBody: jsonBody(LabelTemplateCreateReq),
        responses: { "200": jsonRes("OK", LabelTemplateRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/label-templates/{id}": {
      put: {
        tags: ["标签模板"],
        summary: "编辑标签模板（HQ）",
        description: "仅传要改的字段；每次保存 version+1。",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        requestBody: jsonBody(LabelTemplateUpdateReq),
        responses: { "200": jsonRes("OK", LabelTemplateRes), ...ERROR_RESPONSES },
      },
      delete: {
        tags: ["标签模板"],
        summary: "删除标签模板（HQ）",
        description: "如果删除的是默认模板，会自动把最近更新的一条晋升为默认。",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        responses: { "200": jsonRes("OK", LabelTemplateDeleteRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/label-templates/{id}/set-default": {
      post: {
        tags: ["标签模板"],
        summary: "把某个模板设为默认（HQ）",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        responses: { "200": jsonRes("OK", LabelTemplateSetDefaultRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/parcels": {
      get: {
        tags: ["日本小包"],
        summary: "日本小包列表 · 支持商品/包裹两种维度（super_admin 独占，v1.7）",
        description:
          "只读。`bucket=pending` 返回三档进行中，`bucket=received` 返回两档已签收。`mode=item` 返回子商品扁平列表（含 landed_cny + piece_price），`mode=parcel` 返回聚合包裹卡片。前端搜索时应强制传 `mode=item`。非 super_admin 返回 403 `unauthorized_role`。",
        requestParams: { query: ParcelListQuery },
        responses: { "200": jsonRes("OK", ParcelListRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/parcels/counts": {
      get: {
        tags: ["日本小包"],
        summary: "包裹 Tab 徽标数字（v1.7）",
        description: "同一 super_admin 门槛。返回 pending / received 两个整数。",
        responses: { "200": jsonRes("OK", ParcelCountsRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/parcels/{id}": {
      get: {
        tags: ["日本小包"],
        summary: "包裹详情 + 拆包成本（v1.7）",
        description:
          "服务端已按重量分摊国际运费 + 关税，返回 items[].landed 里的到岸单价 / 拆包单件价 / 小计。APP 直接展示。",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        responses: { "200": jsonRes("OK", ParcelDetailRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/parcels/items/{itemId}/pack-pieces": {
      post: {
        tags: ["日本小包"],
        summary: "保存拆包件数 & 单位（super_admin 独占，v1.7）",
        description:
          "写入 `japan_parcel_items.pack_pieces / pack_pieces_source / pack_unit_note`。传 `pack_pieces=0` 或 null 表示清空。返回该 item 最新的每小件价（CNY/JPY）。",
        requestParams: { path: z.object({ itemId: z.string().uuid() }) },
        requestBody: jsonBody(ParcelPackPiecesReq),
        responses: { "200": jsonRes("OK", ParcelPackPiecesRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/parcels/items/{itemId}/pack-pieces/estimate-title": {
      post: {
        tags: ["日本小包"],
        summary: "AI 标题分析整包件数（super_admin 独占，v1.7）",
        description:
          "服务端从 DB 读该 item 的中/日文标题，调 Lovable AI Gateway（gemini-3-flash-preview）返回件数、置信度、推理、单位。命中 `rate_limited / ai_credits_exhausted` 时按 429/402 返回。",
        requestParams: { path: z.object({ itemId: z.string().uuid() }) },
        responses: { "200": jsonRes("OK", ParcelEstimateRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/handheld/parcels/items/{itemId}/pack-pieces/estimate-image": {
      post: {
        tags: ["日本小包"],
        summary: "AI 图片视觉识别整包件数（super_admin 独占，v1.7）",
        description:
          "服务端读 item 的 image_url，转为 1024px 缩略图后调 Lovable AI Gateway（gemini-2.5-flash）。无图片返回 422。",
        requestParams: { path: z.object({ itemId: z.string().uuid() }) },
        responses: { "200": jsonRes("OK", ParcelEstimateRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/pos/payments/micropay": {
      post: {
        tags: ["收银支付"],
        summary: "主扫：收银员扫客户微信/支付宝付款码",
        description:
          "服务端重算应收金额、校验班次与门店支付主体后调用支付机构。返回 status=user_paying 时表示客户正在输入密码，APP 需轮询 GET /api/public/pos/payments/{id}。门店未完成支付主体认证或服务端未配置密钥时返回 503 payment_not_configured。",
        requestBody: jsonBody(PosMicropayBody),
        responses: { "200": jsonRes("OK", PosPaymentAttemptRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/pos/payments/qr-order": {
      post: {
        tags: ["收银支付"],
        summary: "客扫：生成本单动态收款二维码",
        description: "只生成订单专属动态码（微信 Native / 支付宝 precreate），不使用门店静态码。",
        requestBody: jsonBody(PosQrOrderBody),
        responses: { "201": jsonRes("Created", PosPaymentAttemptRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/pos/payments/{id}": {
      get: {
        tags: ["收银支付"],
        summary: "查询支付流水（APP 轮询）",
        description: "未终态时会主动向支付机构查单；支付成功会返回 receipt 小票数据。",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        responses: { "200": jsonRes("OK", PosPaymentAttemptRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/pos/payments/{id}/close": {
      post: {
        tags: ["收银支付"],
        summary: "关闭支付流水",
        description: "只允许关闭 pending / user_paying；关闭前会再查一次，避免误关已支付订单。",
        requestParams: { path: z.object({ id: z.string().uuid() }) },
        responses: { "200": jsonRes("OK", PosPaymentAttemptRes), ...ERROR_RESPONSES },
      },
    },
    "/api/public/pos/payments/callback/{provider}": {
      post: {
        tags: ["收银支付"],
        summary: "微信 / 支付宝异步回调",
        description:
          "支付机构服务器回调。严格验签 + 金额 + 商户校验后幂等完成销售。不对 APP 开放。",
        security: [],
        requestParams: { path: z.object({ provider: z.enum(["wechat", "alipay"]) }) },
        responses: { "200": jsonRes("OK", z.object({ code: z.string().optional() })) },
      },
    },
  },

};

let cached: ReturnType<typeof createDocument> | null = null;

export function buildHandheldOpenApi() {
  if (!cached) cached = createDocument(document);
  return cached;
}
