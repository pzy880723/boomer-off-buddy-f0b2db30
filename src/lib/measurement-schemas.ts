import { z } from "zod";

/**
 * 旧素材上报 serverFn 的输入：failed-only。
 * ready 只允许经 POST /api/public/handheld/items/{id}/measurement-image（服务端 PNG 校验 + 登记 RPC）。
 */
export const reportMeasurementDiagramInput = z
  .object({
    sku_id: z.string().uuid(),
    revision: z.number().int().min(0),
    status: z.literal("failed"),
    error: z.string().max(500).nullable().optional(),
  })
  .strict();
