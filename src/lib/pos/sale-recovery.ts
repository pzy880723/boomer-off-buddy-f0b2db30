import { z } from "zod";

export const SaleRecoveryRequest = z
  .object({
    shift_id: z.string().uuid(),
    client_op_id: z.string().trim().min(8).max(100),
  })
  .strict();

// Money is in yuan, matching the existing /sales response, not native cents.
export const SaleRecoveryResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("cancelled"),
    client_op_id: z.string(),
    order: z.null(),
  }),
  z.object({
    status: z.literal("completed"),
    client_op_id: z.string(),
    order: z.object({
      order_id: z.string().uuid(),
      order_no: z.string(),
      subtotal: z.number().nonnegative(),
      discount_total: z.number().nonnegative(),
      total_amount: z.number().nonnegative(),
      points_redemption: z.record(z.string(), z.unknown()).nullable(),
    }),
  }),
]);

export type PosSaleRecoveryResult = z.infer<typeof SaleRecoveryResult>;
