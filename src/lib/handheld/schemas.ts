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

export const ErrorResponse = z
  .object({
    ok: z.literal(false),
    error: z.string().meta({ description: "人类可读错误信息", example: "Invalid body" }),
    code: z.string().optional().meta({ description: "可选机器可读错误码" }),
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

// ============================================================
// 1. auth/ping
// ============================================================

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
  })
  .meta({ id: "DeviceContext" });

export const AuthPingRes = okEnvelope(DeviceContextSchema);

// ============================================================
// 2. SKU 查询
// ============================================================

export const SkuSummarySchema = z
  .object({
    id: uuidSchema,
    sku_code: z.string().meta({ example: "TOY-PIKA-001" }),
    name: z.string().meta({ example: "皮卡丘公仔" }),
    category: z.string().nullable(),
    price_tier: z.string().nullable().meta({ description: "价格档枚举" }),
    stock_qty: z.number().int().meta({ example: 12 }),
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

export const StocktakeSummarySchema = z
  .object({
    id: uuidSchema,
    code: z.string().meta({ example: "ST-20260627-AB12" }),
    status: z.enum(["scanning", "submitted", "reviewed", "applied", "cancelled"]),
    opened_at: z.string().datetime(),
    reused: z
      .boolean()
      .meta({ description: "true=复用了同库位的已开盘点单；false=新建" }),
  })
  .meta({ id: "StocktakeSummary" });

export const StocktakeOpenRes = okEnvelope(StocktakeSummarySchema);

export const StocktakeScanReq = z
  .object({
    stocktake_id: uuidSchema,
    epcs: z.array(epcSchema).min(1).max(1000),
  })
  .meta({ id: "StocktakeScanReq" });

export const StocktakeScanRes = okEnvelope(
  z.object({
    received: z.number().int(),
    unknown_count: z.number().int(),
    unknown: z.array(epcSchema),
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

export const AiRecognizeReq = z
  .object({
    image_url: z.string().url().optional(),
    image_base64: z.string().optional(),
    hint: z.string().optional().meta({ description: "店员补充提示，可选" }),
  })
  .refine((v) => v.image_url || v.image_base64, { message: "image_url 或 image_base64 必传其一" })
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
  })
  .meta({ id: "UploadImageReq" });

export const UploadImageRes = okEnvelope(
  z.object({
    storage_path: z.string(),
    upload_url: z.string().url().meta({ description: "30 分钟有效，PUT 直传" }),
    read_url: z.string().url().meta({ description: "7 天 signed GET URL" }),
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()).meta({ description: "上传时必须带这些 header" }),
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
    image_url: z.string().url().nullable().optional().meta({ description: "上架图 signed URL 或外链" }),
    weight_g: z.number().nullable().optional(),
    epcs: z.array(epcSchema).max(50).optional().meta({ description: "已打好标签则一并绑定" }),
    auto_push_youzan: z.boolean().default(false).meta({ description: "默认 false，APP 给开关；true 时入库存同步队列" }),
  })
  .meta({ id: "SmartCreateReq" });

export const SmartCreateRes = okEnvelope(
  z.object({
    sku_id: uuidSchema,
    sku_code: z.string(),
    epc: z.string().meta({ description: "本 SKU 的共享 EPC（类目+价格档+品名 唯一）" }),
    stock_qty: z.number().int(),
    bound_epcs: z.number().int(),
    label: z.object({
      sku_code: z.string(),
      epc: z.string(),
      name: z.string(),
      price_cny: z.number(),
      grade: z.string().nullable(),
      location_name: z.string().nullable(),
      qrcode_payload: z.string(),
    }),
    youzan_sync_status: z.enum(["disabled", "queued", "linked", "unlinked"]),
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
  })
  .meta({ id: "RfidTransferReq" });

export const RfidTransferRes = okEnvelope(
  z.object({ epc: epcSchema, from_location_id: uuidSchema.nullable(), to_location_id: uuidSchema }),
);

