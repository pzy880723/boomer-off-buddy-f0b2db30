/**
 * 手持终端 Public API — 单一真源（Single Source of Truth）
 *
 * 这里定义所有 /api/public/handheld/* 接口的 请求 / 响应 Zod schema。
 *  - 服务端路由 handler 用它做运行时校验。
 *  - src/lib/handheld/openapi.ts 用它生成 OpenAPI 3.1 文档。
 *  - 文档站 /api-docs 读取生成的 openapi.json 渲染。
 *  - APP 端用 openapi.json 生成 TS/Dart/Kotlin SDK。
 *
 * 改字段：只动这一个文件。CI 的 sdk:check 会检测漂移。
 */
import * as z from "zod";
/// <reference types="zod-openapi" />
// Zod v4 的 .meta() 原生支持任意元数据；zod-openapi 通过类型补全 OpenAPI 字段。

// ============================================================
// 通用
// ============================================================

/**
 * 业务错误码（APP 直接按 code 做页面提示）。
 *  - unauthorized：401，缺失/失效 token
 *  - unauthorized_location：401，session 当前 location 与请求不符
 *  - invalid_body：400，请求体不是合法 JSON / 缺字段
 *  - validation_error：422，Zod 校验失败（detail 含字段路径）
 *  - not_found：404，资源不存在
 *  - unlinked：404，EPC 未绑定任何 SKU（GET /rfid/{epc}）
 *  - already_exists：409，barcode / EPC 已绑到其它 SKU
 *  - transfer_required：409，EPC 当前不在本 location，需要走调拨流程
 *  - rate_limited：429，AI 网关限流
 *  - ai_credits_exhausted：402，AI 网关额度耗尽
 *  - internal_error：500
 */
export const HandheldErrorCode = z.enum([
  "unauthorized",
  "unauthorized_location",
  "invalid_body",
  "validation_error",
  "not_found",
  "unlinked",
  "already_exists",
  "transfer_required",
  "rate_limited",
  "ai_credits_exhausted",
  "internal_error",
]);

export const ErrorResponse = z
  .object({
    ok: z.literal(false),
    code: HandheldErrorCode.optional().meta({ description: "业务错误码；APP 按此分支" }),
    error: z.string().meta({ description: "人类可读错误信息", example: "Invalid body" }),
    detail: z.string().optional(),
    issues: z.array(z.string()).optional(),
    missingReceive: z.array(z.string()).optional(),
  })
  .meta({ id: "ErrorResponse" });

/** 包一层 { ok: true, data: T }，文档展示用 */
export const okEnvelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ ok: z.literal(true), data });

const epcSchema = z
  .string()
  .min(1)
  .meta({ description: "RFID EPC 编码", example: "E2000017220C00000000A1B2" });

const uuidSchema = z.string().uuid().meta({ example: "550e8400-e29b-41d4-a716-446655440000" });

/** v1.2：离线幂等键。APP 端为每个写请求生成一个 UUID/ULID，重试时回放上一次响应。 */
export const ClientOpId = z
  .string()
  .min(8)
  .max(64)
  .meta({ description: "客户端幂等键；同一 device + client_op_id 服务端只执行一次" });

// ============================================================
// 1. auth/ping
// ============================================================

/** v1.2：设备能力上报，APP 启动后用于自适应 UI。 */
export const DeviceCapabilities = z
  .object({
    reader_model: z
      .enum(["SUNMI_V3", "RFID_PDA", "UNKNOWN"])
      .default("UNKNOWN"),
    has_printer: z.boolean().default(false),
    has_rfid_reader: z.boolean().default(false),
    has_barcode_scanner: z.boolean().default(false),
    has_camera: z.boolean().default(true),
  })
  .meta({ id: "DeviceCapabilities" });

export const DeviceContextSchema = z
  .object({
    id: uuidSchema,
    device_code: z.string().meta({ example: "HH-001" }),
    label: z.string().meta({ example: "总仓 1 号机" }),
    location_id: uuidSchema.nullable(),
    location_kind: z
      .enum(["warehouse", "shop"])
      .nullable()
      .meta({ description: "warehouse=仓库 / shop=门店" }),
    location_name: z.string().nullable().meta({ example: "总仓" }),
    device_capabilities: DeviceCapabilities.meta({
      description: "v1.2：设备能力。后台未设置时全字段走默认值",
    }),
    app_version: z.string().nullable(),
    os_version: z.string().nullable(),
  })
  .meta({ id: "DeviceContext" });

export const AuthPingRes = okEnvelope(DeviceContextSchema);

// ============================================================
// 2. SKU 查询
// ============================================================

export const SkuSummarySchema = z
  .object({
    id: uuidSchema,
    sku_code: z.string().nullable().meta({ example: "TOY-PIKA-001" }),
    name: z.string().meta({ example: "皮卡丘公仔" }),
    category: z.string().nullable(),
    price_tier: z.number().nullable().meta({ description: "价格档 / 售价" }),
    stock_qty: z.number().int().meta({ example: 12 }),
    image_url: z.string().nullable().meta({ description: "主图 read URL；没有图片时为 null" }),
    image_paths: z.array(z.string()).default([]).meta({ description: "持久图片路径列表" }),
    images: z
      .array(
        z.object({
          storage_path: z.string(),
          read_url: z.string(),
        }),
      )
      .default([])
      .meta({ description: "可直接展示的图片 URL 列表" }),
  })
  .meta({ id: "SkuSummary" });

export const SkuByEpcQuery = z.object({ epc: epcSchema });

export const SkuByEpcRes = okEnvelope(
  z.union([
    z.object({
      known: z.literal(true),
      epc: epcSchema,
      status: z.string().meta({ example: "in_stock" }),
      sku_id: uuidSchema.nullable(),
      current_location_id: uuidSchema.nullable(),
      sku: SkuSummarySchema.nullable(),
      location: z
        .object({
          id: uuidSchema,
          name: z.string(),
          kind: z.enum(["warehouse", "shop"]),
        })
        .nullable(),
    }),
    z.object({
      known: z.literal(false),
      unclaimed: z
        .object({
          epc: epcSchema,
          hits: z.number().int(),
          last_seen_at: z.string().datetime(),
        })
        .nullable(),
    }),
  ]),
);

export const SkuSearchQuery = z.object({
  q: z.string().optional().meta({ description: "关键字，匹配 sku_code / name" }),
});

export const SkuSearchRes = okEnvelope(z.object({ items: z.array(SkuSummarySchema) }));

export const ProductTypeSchema = z.enum(["standard", "custom", "bundle"]);

export const ProductStockSchema = z
  .object({
    location_id: uuidSchema,
    location_name: z.string(),
    location_kind: z.enum(["warehouse", "shop"]),
    stock_qty: z.number().int(),
  })
  .meta({ id: "ProductStock" });

export const ProductItemSchema = z
  .object({
    id: uuidSchema,
    product_type: ProductTypeSchema,
    sku_code: z.string().nullable(),
    barcode: z.string().nullable(),
    item_code: z.string().nullable(),
    name: z.string(),
    category: z.string().nullable(),
    price: z.number(),
    condition_grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable(),
    image_url: z.string().nullable().meta({ description: "主图 read URL；没有图片时为 null" }),
    image_paths: z.array(z.string()).default([]),
    images: z
      .array(
        z.object({
          storage_path: z.string(),
          read_url: z.string(),
        }),
      )
      .default([]),
    notes: z.string().nullable(),
    total_stock_qty: z.number().int(),
    stocks: z.array(ProductStockSchema),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .meta({ id: "ProductItem" });

export const ProductSortSchema = z
  .enum(["created_desc", "created_asc", "price_desc", "price_asc", "stock_desc", "updated_desc"])
  .default("updated_desc");

export const ProductsQuery = z
  .object({
    q: z.string().optional(),
    type: z.enum(["standard", "custom", "bundle", "all"]).default("all"),
    scope: z.enum(["authorized", "current_location"]).default("authorized"),
    location_id: uuidSchema.optional(),
    category: z.string().optional().meta({ description: "分类精确匹配" }),
    has_image: z.enum(["0", "1"]).optional().meta({ description: "仅 custom 生效" }),
    sort: ProductSortSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(200).default(50),
  })
  .meta({ id: "ProductsQuery" });

export const ProductsRes = okEnvelope(
  z.object({
    items: z.array(ProductItemSchema),
    total: z.number().int(),
    page: z.number().int(),
    page_size: z.number().int(),
    counts: z
      .object({
        custom: z.number().int(),
        bundle: z.number().int(),
        standard: z.number().int(),
        all: z.number().int(),
      })
      .meta({ description: "各 type 的角标计数（受 q/category 过滤影响，不受 type 影响）" }),
  }),
);

export const ProductLookupQuery = z
  .object({
    code: z.string().optional().meta({ description: "barcode / sku_code / EPC / QR JSON" }),
    q: z.string().optional().meta({ description: "兼容 APP 测试；无 code 时按关键字返回第一条" }),
  })
  .meta({ id: "ProductLookupQuery" });

export const ProductLookupRes = okEnvelope(ProductItemSchema);

// ============================================================
// 2.5 全局库存视图 global-stock（总仓账号专用）
// ============================================================

export const GlobalStockLocationSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    kind: z.enum(["warehouse", "shop"]),
  })
  .meta({ id: "GlobalStockLocation" });

export const GlobalStockItemSchema = z
  .object({
    sku_id: uuidSchema,
    name: z.string(),
    sku_code: z.string().nullable(),
    barcode: z.string().nullable(),
    category: z.string().nullable(),
    product_type: ProductTypeSchema,
    image_url: z.string().nullable(),
    price: z.number(),
    total_qty: z.number().int(),
    stocks: z.record(z.string(), z.number().int()).meta({
      description: "key = location_id, value = qty；没有的库位不会出现，前端按 0 处理",
    }),
  })
  .meta({ id: "GlobalStockItem" });

export const GlobalStockQuery = z
  .object({
    type: z.enum(["standard", "custom", "bundle"]).meta({ description: "必传，按 Tab 过滤" }),
    q: z.string().optional(),
    category: z.string().optional(),
    stock_state: z.enum(["all", "out", "low"]).default("all"),
    low_threshold: z.coerce.number().int().min(1).default(5),
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(200).default(50),
  })
  .meta({ id: "GlobalStockQuery" });

export const GlobalStockRes = okEnvelope(
  z.object({
    locations: z.array(GlobalStockLocationSchema),
    items: z.array(GlobalStockItemSchema),
    summary: z.object({
      sku_count: z.number().int(),
      total_qty: z.number().int(),
      out_of_stock: z.number().int(),
      low_stock: z.number().int(),
    }),
    page: z.number().int(),
    page_size: z.number().int(),
    total: z.number().int(),
  }),
);

// ============================================================
// 3. 入库 inbound/scan
// ============================================================

export const InboundScanReq = z
  .object({
    epcs: z.array(epcSchema).min(1).max(500).meta({
      description: "一次最多 500 个 EPC。已扫过的会被去重",
    }),
  })
  .meta({ id: "InboundScanReq" });

export const InboundScanRes = okEnvelope(
  z.object({
    accepted_count: z.number().int(),
    duplicated_count: z.number().int(),
    unclaimed_count: z.number().int(),
    accepted: z.array(z.object({ epc: epcSchema, sku_id: uuidSchema })),
    duplicated: z.array(
      z.object({
        epc: epcSchema,
        reason: z.string().meta({ example: "already_in_stock" }),
      }),
    ),
    unclaimed: z
      .array(epcSchema)
      .meta({ description: "未在系统中的 EPC，自动进入「待认领 EPC」队列" }),
  }),
);

// ============================================================
// 4. 盘点 stocktake/*
// ============================================================

export const StocktakeOpenReq = z
  .object({ name: z.string().optional().meta({ description: "可选备注" }) })
  .meta({ id: "StocktakeOpenReq" });

export const StocktakeParticipant = z
  .object({
    device_id: uuidSchema,
    device_code: z.string().nullable(),
    label: z.string().nullable(),
    scan_count: z.number().int(),
    last_scan_at: z.string().datetime().nullable(),
  })
  .meta({ id: "StocktakeParticipant" });

export const StocktakeSummarySchema = z
  .object({
    id: uuidSchema,
    code: z.string().meta({ example: "ST-20260627-AB12" }),
    status: z.enum(["scanning", "submitted", "reviewed", "applied", "cancelled"]),
    opened_at: z.string().datetime(),
    reused: z
      .boolean()
      .meta({ description: "true=复用了同库位的已开盘点单；false=新建" }),
    participants: z
      .array(StocktakeParticipant)
      .default([])
      .meta({ description: "v1.2：当前正在协作的 PDA 列表（按最近扫描时间）" }),
  })
  .meta({ id: "StocktakeSummary" });

export const StocktakeOpenRes = okEnvelope(StocktakeSummarySchema);

export const StocktakeScanReq = z
  .object({
    stocktake_id: uuidSchema,
    epcs: z.array(epcSchema).min(1).max(1000),
    client_op_id: ClientOpId.optional(),
  })
  .meta({ id: "StocktakeScanReq" });

export const StocktakeScanRes = okEnvelope(
  z.object({
    received: z.number().int(),
    unknown_count: z.number().int(),
    unknown: z.array(epcSchema),
    participants: z.array(StocktakeParticipant).default([]),
  }),
);

export const StocktakeSubmitReq = z
  .object({ stocktake_id: uuidSchema })
  .meta({ id: "StocktakeSubmitReq" });

export const StocktakeSubmitRes = okEnvelope(
  z.object({
    stocktake_id: uuidSchema,
    lines: z.number().int().meta({ description: "生成的差异行数" }),
    diff_total: z.number().int().meta({ description: "counted - system 的总和" }),
  }),
);

// ============================================================
// 5. 调拨 transfer/*
// ============================================================

export const TransferScanReq = z
  .object({
    transfer_id: uuidSchema,
    epcs: z.array(epcSchema).min(1).max(1000),
  })
  .meta({ id: "TransferScanReq" });

export const TransferConfirmReq = z
  .object({ transfer_id: uuidSchema })
  .meta({ id: "TransferConfirmReq" });

export const TransferScanRes = okEnvelope(
  z.object({
    received: z.number().int(),
    unknown_count: z.number().int(),
    unknown: z.array(epcSchema),
  }),
);

export const TransferShipConfirmRes = okEnvelope(
  z.object({ transfer_id: uuidSchema, shipped: z.number().int() }),
);

export const TransferReceiveConfirmRes = okEnvelope(
  z.object({ transfer_id: uuidSchema, received: z.number().int() }),
);

// ============================================================
// 兼容导出：handheld-transfer.server 早期版本从那里导出 ScanBody / ConfirmBody
// 新代码请从本文件 import TransferScanReq / TransferConfirmReq
// ============================================================
export const ScanBody = TransferScanReq;
export const ConfirmBody = TransferConfirmReq;

// ============================================================
// 6. 账号登录 / 库位切换（v1.1 新增）
// ============================================================

export const LoginReq = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
    capabilities: DeviceCapabilities.optional(),
    app_version: z.string().max(40).optional(),
    os_version: z.string().max(40).optional(),
  })
  .meta({ id: "LoginReq" });

export const LocationSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    kind: z.enum(["warehouse", "shop"]),
    is_active: z.boolean(),
  })
  .meta({ id: "Location" });

export const SessionUserSchema = z
  .object({
    user_id: uuidSchema,
    email: z.string().nullable(),
    display_name: z.string().nullable(),
    roles: z.array(z.string()),
  })
  .meta({ id: "SessionUser" });

export const LoginRes = okEnvelope(
  z.object({
    access_token: z.string().meta({ description: "Supabase access token；后续接口请放到 X-Session-Token Header" }),
    refresh_token: z.string(),
    expires_at: z.number().int().meta({ description: "unix 秒" }),
    user: SessionUserSchema,
    locations: z.array(LocationSchema),
  }),
);

export const LocationsRes = okEnvelope(z.object({ items: z.array(LocationSchema) }));

export const LocationSwitchReq = z
  .object({ location_id: uuidSchema })
  .meta({ id: "LocationSwitchReq" });

export const LocationSwitchRes = okEnvelope(
  z.object({
    device_id: uuidSchema,
    location: LocationSchema,
  }),
);

// ============================================================
// 7. AI 识别 / 出图（v1.1 新增）
// ============================================================

const INV_CATEGORY = z.enum([
  "jp_porcelain",
  "eu_porcelain",
  "vintage_toy",
  "anime_goods",
  "media",
  "digital",
  "jewelry",
  "fashion",
  "daily",
  "antique",
]);

export const AiRecognizeImage = z
  .object({
    image_url: z.string().url().optional(),
    image_base64: z.string().optional(),
  })
  .refine((v) => v.image_url || v.image_base64, {
    message: "image_url 或 image_base64 必传其一",
  });

export const AiRecognizeReq = z
  .object({
    // 单图字段（向后兼容旧 APP）
    image_url: z.string().url().optional(),
    image_base64: z.string().optional(),
    // v1.2 多图：最多 4 张。images[0] 为主图。
    images: z.array(AiRecognizeImage).min(1).max(4).optional(),
    hint: z.string().optional().meta({ description: "店员补充提示，可选" }),
  })
  .refine((v) => v.image_url || v.image_base64 || (v.images && v.images.length > 0), {
    message: "image_url / image_base64 / images 至少传一项",
  })
  .meta({ id: "AiRecognizeReq" });

export const AiRecognizeRes = okEnvelope(
  z.object({
    name: z.string(),
    category: INV_CATEGORY.nullable(),
    brand: z.string().nullable(),
    era: z.string().nullable().meta({ description: "年代，如 1970s" }),
    condition_grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable(),
    description: z.string().nullable(),
    suggested_price_cny: z.number().nullable(),
    raw: z.unknown().optional(),
  }),
);

export const AiListingImageReq = z
  .object({
    image_url: z.string().url().optional(),
    image_base64: z.string().optional(),
    instruction: z.string().optional().meta({ description: "可选额外指令；默认只做角度/裁切/底色/光线" }),
  })
  .refine((v) => v.image_url || v.image_base64, { message: "image_url 或 image_base64 必传其一" })
  .meta({ id: "AiListingImageReq" });

export const AiListingImageRes = okEnvelope(
  z.object({
    storage_path: z.string().meta({ description: "sku-listing/xxx.png" }),
    signed_url: z.string().url().meta({ description: "7 天 signed URL，APP 直接展示" }),
    mime_type: z.string(),
  }),
);

// ============================================================
// 8. 图片上传（前端先调拿 signed URL，再 PUT 上传）
// ============================================================

export const UploadImageReq = z
  .object({
    bucket: z.enum(["sku-raw", "sku-listing"]).default("sku-raw"),
    filename: z.string().min(1).meta({ description: "原始文件名，仅用于扩展名识别" }),
    content_type: z.string().min(1).meta({ example: "image/jpeg" }),
    mode: z
      .enum(["signed", "multipart"])
      .default("signed")
      .meta({
        description:
          "signed=返回 signed PUT URL，APP 直传 Storage（推荐）；multipart=同时返回一个 ERP 中转 POST 端点，APP 走 multipart/form-data 上传（兼容受限网络）。",
      }),
  })
  .meta({ id: "UploadImageReq" });

export const UploadImageRes = okEnvelope(
  z.object({
    storage_path: z.string(),
    upload_url: z.string().url().meta({ description: "30 分钟有效；signed 模式为 Storage PUT URL，multipart 模式为 ERP 中转 POST URL" }),
    read_url: z
      .string()
      .url()
      .nullable()
      .meta({
        description:
          "上传前对象还不存在，无法签发 read URL；总是返回 null。上传完成后调 POST /items/sign-read-url 拿 7 天 signed GET URL。",
      }),
    method: z.enum(["PUT", "POST"]),
    mode: z.enum(["signed", "multipart"]),
    headers: z.record(z.string(), z.string()).meta({ description: "上传时必须带这些 header" }),
  }),
);

export const SignReadUrlReq = z
  .object({
    bucket: z.enum(["sku-raw", "sku-listing"]),
    storage_path: z.string().min(1),
    expires_in: z.number().int().min(60).max(60 * 60 * 24 * 30).default(60 * 60 * 24 * 7),
  })
  .meta({ id: "SignReadUrlReq" });

export const SignReadUrlRes = okEnvelope(
  z.object({
    storage_path: z.string(),
    read_url: z.string().url(),
    expires_in: z.number().int(),
  }),
);

export const AttachImagesReq = z
  .object({
    image_storage_paths: z
      .array(
        z.object({
          bucket: z.enum(["sku-raw", "sku-listing"]),
          storage_path: z.string().min(1),
        }),
      )
      .max(12)
      .default([]),
    image_url: z
      .string()
      .url()
      .nullable()
      .optional()
      .meta({ description: "兼容旧 APP；signed URL 会被反解为 storage path，不直接落库" }),
  })
  .refine((v) => v.image_storage_paths.length > 0 || !!v.image_url, {
    message: "image_storage_paths 或 image_url 至少传一项",
  })
  .meta({ id: "AttachImagesReq" });

export const AttachImagesRes = okEnvelope(
  z.object({
    sku_id: uuidSchema,
    image_url: z.string().nullable(),
    image_paths: z.array(z.string()),
    images: z.array(
      z.object({
        storage_path: z.string(),
        read_url: z.string(),
      }),
    ),
  }),
);

// ============================================================
// 9. 智能上架 items/smart-create + 同步状态
// ============================================================

export const SmartCreateReq = z
  .object({
    location_id: uuidSchema.optional().meta({ description: "默认用当前设备库位" }),
    name: z.string().min(1).max(120),
    category: INV_CATEGORY,
    price_tier: z.number().positive().max(9999.9),
    is_custom_price: z.boolean().default(false),
    grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable().optional(),
    notes: z.string().nullable().optional(),
    image_url: z
      .string()
      .url()
      .nullable()
      .optional()
      .meta({ description: "（兼容旧版）单张外链/signed URL。推荐改用 image_storage_paths。" }),
    image_storage_paths: z
      .array(
        z.object({
          bucket: z.enum(["sku-raw", "sku-listing"]),
          storage_path: z.string().min(1),
        }),
      )
      .max(6)
      .optional()
      .meta({
        description:
          "APP 通过 /items/upload-image 上传得到的 storage_path 列表。第 0 张是主图。永久保存到 inv_skus.image_paths，ERP 端按需签 URL。",
      }),
    weight_g: z.number().nullable().optional(),
    epcs: z.array(epcSchema).max(50).optional().meta({ description: "已打好标签则一并绑定" }),
    auto_push_youzan: z.boolean().default(false).meta({ description: "默认 false，APP 给开关；true 时入库存同步队列" }),
    client_op_id: ClientOpId.optional(),
  })
  .meta({ id: "SmartCreateReq" });

/** v1.2：扁平打印 payload，APP 自渲染 ZPL/ESC-POS。 */
export const PrintPayloadSchema = z
  .object({
    sku_code: z.string().nullable(),
    barcode: z.string().nullable(),
    title_short: z.string().meta({ description: "<=24 字符截断" }),
    price_tag: z.string().meta({ example: "¥699" }),
    grade: z.string().nullable(),
  })
  .meta({ id: "PrintPayload" });

export const SmartCreateRes = okEnvelope(
  z.object({
    sku_id: uuidSchema,
    sku_code: z.string(),
    barcode: z.string().nullable().meta({ description: "EAN-13 全局唯一条码，自动生成" }),
    epc: z.string().meta({ description: "本 SKU 的共享 EPC（类目+价格档+品名 唯一）" }),
    condition_grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable(),
    stock_qty: z.number().int(),
    bound_epcs: z.number().int(),
    label: z.object({
      sku_code: z.string(),
      barcode: z.string().nullable(),
      epc: z.string(),
      name: z.string(),
      price_cny: z.number(),
      grade: z.string().nullable(),
      condition_grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable(),
      location_name: z.string().nullable(),
      qrcode_payload: z.string(),
    }),
    print_payload: PrintPayloadSchema.meta({ description: "v1.2：扁平结构，直接灌打印模板" }),
    youzan_sync_status: z.enum(["disabled", "queued", "linked", "unlinked", "hq_created", "hq_failed"]),
  }),
);

export const SyncStatusRes = okEnvelope(
  z.object({
    sku_id: uuidSchema,
    links: z.array(
      z.object({
        shop_id: uuidSchema,
        shop_name: z.string().nullable(),
        yz_item_id: z.number().nullable(),
        last_pushed_stock: z.number().int().nullable(),
        last_pushed_at: z.string().nullable(),
        status: z.string(),
        last_error: z.string().nullable(),
      }),
    ),
    queue: z.array(
      z.object({
        target_stock: z.number().int(),
        status: z.string(),
        attempts: z.number().int(),
        next_run_at: z.string().nullable(),
        last_error: z.string().nullable(),
        created_at: z.string(),
      }),
    ),
  }),
);

// ============================================================
// 10. RFID 单点操作
// ============================================================

export const RfidBindReq = z
  .object({
    epc: epcSchema,
    sku_id: uuidSchema,
    location_id: uuidSchema.optional().meta({ description: "默认设备所在库位" }),
    client_op_id: ClientOpId.optional(),
  })
  .meta({ id: "RfidBindReq" });

export const RfidBindRes = okEnvelope(
  z.object({ epc: epcSchema, sku_id: uuidSchema, location_id: uuidSchema, stock_after: z.number().int() }),
);

export const RfidTransferReq = z
  .object({
    epc: epcSchema,
    to_location_id: uuidSchema,
    reason: z.string().max(120).optional(),
    client_op_id: ClientOpId.optional(),
  })
  .meta({ id: "RfidTransferReq" });

export const RfidTransferRes = okEnvelope(
  z.object({ epc: epcSchema, from_location_id: uuidSchema.nullable(), to_location_id: uuidSchema }),
);

// ============================================================
// 11. RFID 裸 EPC 入库（扫到未绑定的标签先放入待认领队列）
// ============================================================

export const RfidStockInReq = z
  .object({
    epcs: z.array(epcSchema).min(1).max(500),
    client_op_id: ClientOpId.optional(),
  })
  .meta({ id: "RfidStockInReq" });

export const RfidStockInRes = okEnvelope(
  z.object({
    queued: z.number().int().meta({ description: "进入待认领队列的 EPC 数（去重后）" }),
    already_bound: z.array(z.object({ epc: epcSchema, sku_id: uuidSchema })).meta({
      description: "已绑定 SKU 的 EPC，APP 端应该改走 inbound/scan 或 transfer-location",
    }),
  }),
);

// ============================================================
// 12. Auth 扩展：refresh / me / logout（Supabase token 直通）
// ============================================================

export const AuthRefreshReq = z
  .object({ refresh_token: z.string().min(1) })
  .meta({ id: "AuthRefreshReq" });

export const AuthRefreshRes = okEnvelope(
  z.object({
    access_token: z.string(),
    refresh_token: z.string(),
    expires_at: z.number().int().meta({ description: "unix 秒；access_token 默认 2 小时" }),
  }),
);

export const AuthMeRes = okEnvelope(
  z.object({
    device: DeviceContextSchema,
    user: SessionUserSchema.nullable().meta({ description: "未带 X-Session-Token 时为 null" }),
  }),
);

// ============================================================
// 13. SKU 详情（APP 查 barcode / condition_grade / 当前库存）
// ============================================================

export const SkuDetailRes = okEnvelope(
  z.object({
    id: uuidSchema,
    sku_code: z.string().nullable(),
    barcode: z.string().nullable(),
    epc: z.string(),
    name: z.string(),
    category: z.string(),
    price_tier: z.number(),
    is_custom_price: z.boolean(),
    condition_grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable(),
    grade: z.string().nullable().meta({ description: "兼容旧字段，等同 condition_grade" }),
    image_url: z.string().nullable().meta({ description: "主图 read URL（兼容旧 APP）；优先用 images" }),
    image_paths: z.array(z.string()).meta({
      description: "持久化的图片来源列表：可能是 'sku-listing/2026-06-29/xxx.jpg' 形式的私桶路径或 https:// 外链",
    }),
    images: z
      .array(
        z.object({
          storage_path: z.string().meta({ description: "对应 image_paths 里的原值" }),
          read_url: z.string().meta({ description: "可直接渲染的 URL；私桶为 24h signed，外链原样" }),
        }),
      )
      .meta({ description: "image_paths 顺序签名后的结果；第 0 张是主图" }),
    notes: z.string().nullable(),
    weight_g: z.number().nullable(),
    stock_qty: z.number().int(),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    stocks: z.array(
      z.object({
        location_id: uuidSchema,
        location_name: z.string(),
        location_kind: z.enum(["warehouse", "shop"]),
        qty: z.number().int(),
      }),
    ),
    print_payload: PrintPayloadSchema.meta({ description: "v1.2：扁平打印 payload" }),
  }),
);

// ============================================================
// 14. v1.2：离线批量入库 / 通知轮询 / 诊断上报
// ============================================================

export const RfidBatchStockInReq = z
  .object({
    ops: z
      .array(
        z.object({
          client_op_id: ClientOpId,
          epcs: z.array(epcSchema).min(1).max(500),
          scanned_at: z.string().datetime().optional(),
        }),
      )
      .min(1)
      .max(50),
  })
  .meta({ id: "RfidBatchStockInReq" });

export const RfidBatchStockInRes = okEnvelope(
  z.object({
    results: z.array(
      z.object({
        client_op_id: ClientOpId,
        replayed: z.boolean(),
        queued: z.number().int(),
        already_bound: z.array(z.object({ epc: epcSchema, sku_id: uuidSchema })),
      }),
    ),
  }),
);

export const NotificationKind = z.enum([
  "stocktake_assigned",
  "transfer_incoming",
  "youzan_sync_failed",
  "unclaimed_epc_pending",
  "system",
]);

export const NotificationsSinceQuery = z
  .object({
    ts: z.string().datetime().optional().meta({ description: "上次拉取的 server_ts；空=最近 50 条" }),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .meta({ id: "NotificationsSinceQuery" });

export const NotificationItem = z
  .object({
    id: uuidSchema,
    kind: NotificationKind,
    title: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    ts: z.string().datetime(),
  })
  .meta({ id: "NotificationItem" });

export const NotificationsSinceRes = okEnvelope(
  z.object({
    items: z.array(NotificationItem),
    server_ts: z.string().datetime().meta({ description: "下次请求把它当成 ts" }),
  }),
);

export const DiagReportReq = z
  .object({
    kind: z.enum(["crash", "network", "api_error", "device"]),
    message: z.string().min(1).max(4000),
    payload: z.record(z.string(), z.unknown()).optional(),
    app_version: z.string().max(40).optional(),
    os_version: z.string().max(40).optional(),
  })
  .meta({ id: "DiagReportReq" });

export const DiagReportRes = okEnvelope(z.object({ id: uuidSchema }));

// ============================================================
// 15. v1.3：APP 自助引导（一次登录 = 拿 device_token + access_token）
// ============================================================

export const BootstrapReq = z
  .object({
    email: z.string().email().optional().meta({ description: "ERP 邮箱；与 phone 二选一" }),
    phone: z.string().min(6).optional().meta({ description: "ERP 手机号；与 email 二选一" }),
    password: z.string().min(1),
    install_id: z
      .string()
      .min(8)
      .max(64)
      .meta({ description: "APP 首装时生成的稳定 UUID/ULID，持久化在 keystore" }),
    device_label: z.string().max(80).optional().meta({ example: "商米 V3 - 仓库1" }),
    capabilities: DeviceCapabilities.optional(),
    app_version: z.string().max(40).optional(),
    os_version: z.string().max(40).optional(),
  })
  .refine((v) => !!(v.email || v.phone), { message: "email 或 phone 至少传一项" })
  .meta({ id: "BootstrapReq" });

export const BootstrapRes = okEnvelope(
  z.object({
    device_token: z.string().meta({
      description: "之后所有请求带的 X-Device-Token；APP 应安全持久化",
    }),
    device: DeviceContextSchema,
    access_token: z.string(),
    session_token: z.string().meta({ description: "等同 access_token；供 APP 统一写入 X-Session-Token" }),
    refresh_token: z.string(),
    expires_at: z.number().int(),
    user: SessionUserSchema,
    locations: z.array(LocationSchema),
  }),
);

// ============================================================
// 16. v1.4：手机验证码登录（OTP）
// ============================================================

export const OtpSendReq = z
  .object({
    phone: z.string().regex(/^1[3-9]\d{9}$/).meta({ description: "11 位中国大陆手机号" }),
    purpose: z.enum(["login"]).default("login"),
  })
  .meta({ id: "OtpSendReq" });

export const OtpSendRes = okEnvelope(
  z.object({
    ttl: z.number().int().meta({ description: "验证码有效期（秒）" }),
  }),
);

export const OtpVerifyReq = z
  .object({
    phone: z.string().regex(/^1[3-9]\d{9}$/),
    code: z.string().regex(/^\d{6}$/),
    // 不带 install_id → Web 模式，返回 session+user
    // 带 install_id → APP 模式，返回完整 BootstrapRes
    install_id: z.string().min(8).max(64).optional(),
    device_label: z.string().max(80).optional(),
    capabilities: DeviceCapabilities.optional(),
    app_version: z.string().max(40).optional(),
    os_version: z.string().max(40).optional(),
  })
  .meta({ id: "OtpVerifyReq" });

export const OtpVerifyWebRes = okEnvelope(
  z.object({
    session: z.object({
      access_token: z.string(),
      refresh_token: z.string(),
      expires_at: z.number().int(),
    }),
    user: SessionUserSchema,
  }),
);

// ============================================================
// 标签模板（总部统一管理，v1.5）
// ============================================================

export const LabelTemplateItem = z
  .object({
    id: uuidSchema,
    name: z.string(),
    width_mm: z.number(),
    height_mm: z.number(),
    is_default: z.boolean(),
    elements: z.array(z.any()).default([]),
    version: z.number().int().default(1),
    updated_at: z.string(),
  })
  .meta({ id: "LabelTemplateItem" });

export const LabelTemplatesRes = okEnvelope(
  z.object({
    default_template_id: z.string().uuid().nullable(),
    items: z.array(LabelTemplateItem),
    can_manage: z.boolean(),
  }),
);

export const LabelTemplateCreateReq = z
  .object({
    name: z.string().min(1).max(120),
    width_mm: z.number().positive().default(53),
    height_mm: z.number().positive().default(35),
    elements: z.array(z.any()).default([]),
    is_default: z.boolean().optional(),
  })
  .meta({ id: "LabelTemplateCreateReq" });

export const LabelTemplateUpdateReq = z
  .object({
    name: z.string().min(1).max(120).optional(),
    width_mm: z.number().positive().optional(),
    height_mm: z.number().positive().optional(),
    elements: z.array(z.any()).optional(),
    is_default: z.boolean().optional(),
  })
  .meta({ id: "LabelTemplateUpdateReq" });

export const LabelTemplateRes = okEnvelope(LabelTemplateItem);

export const LabelTemplateDeleteRes = okEnvelope(z.object({ deleted: z.boolean() }));

export const LabelTemplateSetDefaultRes = okEnvelope(
  z.object({ default_template_id: uuidSchema }),
);






