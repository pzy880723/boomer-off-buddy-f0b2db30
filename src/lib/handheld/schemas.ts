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
import "zod-openapi/extend"; // 引入后 .meta() 支持 OpenAPI 字段类型

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
