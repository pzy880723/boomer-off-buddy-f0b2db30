// Server-only trusted adapter. Not wired to any route/worker yet; double-gated by env + DB flag.
import { buildPaidFact, orderKey, type PaidOrderInput } from "@/lib/membership/points-earning";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

export function pointsEarningEnvEnabled() {
  return process.env.POINTS_EARNING_ENABLED === "true";
}

async function adminRpc(): Promise<Rpc> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return (name, args) => supabaseAdmin.rpc(name as never, args as never) as never;
}

export async function recordPaidOrderPoints(input: PaidOrderInput, rpc?: Rpc) {
  if (!pointsEarningEnvEnabled()) return { status: "disabled" as const };
  const built = buildPaidFact(input);
  if (!built.ok) return { status: "skipped" as const, reason: built.reason };
  const { data, error } = await (rpc ?? (await adminRpc()))("commerce_points_record_order_paid", built.fact);
  if (error) throw new Error(error.message);
  return data as { status: string };
}

export async function recordRefundPoints(
  input: { source: "erp" | "youzan"; orderId: string; aliases?: string[]; refundKey: string; goodsRefundFen: number },
  rpc?: Rpc,
) {
  if (!pointsEarningEnvEnabled()) return { status: "disabled" as const };
  if (!Number.isSafeInteger(input.goodsRefundFen) || input.goodsRefundFen <= 0) return { status: "skipped" as const, reason: "refund_invalid" };
  const { data, error } = await (rpc ?? (await adminRpc()))("commerce_points_record_order_refund", {
    p_canonical_key: orderKey(input.source, input.orderId), p_alias_keys: input.aliases ?? [],
    p_refund_key: input.refundKey, p_goods_refund_fen: input.goodsRefundFen,
  });
  if (error) throw new Error(error.message);
  return data as { status: string };
}
