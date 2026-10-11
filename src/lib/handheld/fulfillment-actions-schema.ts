// 手持自提/手工发货请求体（OpenAPI 与服务端共用）。严格模式：拒绝 user_id/location_id 等客户端身份字段。
import { z } from "zod";

const Idem = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
export const PickupRedeemBody = z
  .object({ input: z.string().max(200), idempotency_key: Idem, expected_fulfillment_id: z.string().uuid().optional() })
  .strict()
  .meta({ id: "HandheldPickupRedeemReq" });
export const PickupReadyBody = z.object({ fulfillment_id: z.string().uuid(), idempotency_key: Idem }).strict().meta({ id: "HandheldPickupReadyReq" });
export const ManualShipBody = z
  .object({
    provider: z.enum(["sf", "cainiao"]),
    tracking_no: z.string().trim().regex(/^[A-Za-z0-9-]{4,64}$/),
    client_op_id: z.string().trim().regex(/^[A-Za-z0-9_-]{6,80}$/),
    lines: z.array(z.object({ fulfillment_item_id: z.string().uuid(), quantity: z.number().int().min(1).max(99999) }).strict()).min(1).max(200),
  })
  .strict()
  .meta({ id: "HandheldManualShipReq" });
