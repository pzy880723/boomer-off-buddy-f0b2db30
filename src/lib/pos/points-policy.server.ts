import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { PointsRules } from "./points-policy";

export async function loadPointsRules(customerId?: string | null): Promise<PointsRules | null> {
  if (!customerId) return null;
  const { data, error } = await supabaseAdmin.rpc(
    "pos_points_rules" as never, { p_customer_id: customerId } as never,
  );
  // A rolling deployment with no migration is disabled, never a fabricated rate.
  if (error?.code === "PGRST202" || error?.code === "42883") {
    const wallet = await supabaseAdmin.from("pos_customer_wallets" as never)
      .select("points").eq("customer_id", customerId).maybeSingle();
    if (wallet.error) throw new Error(wallet.error.message);
    return {
      enabled: false, customer_active: false,
      available_points: (wallet.data as unknown as { points: number } | null)?.points ?? 0,
      cap_rate: 0, points_per_unit: null, unit_fen: null, policy_version: null,
    };
  }
  if (error) throw new Error(error.message);
  return data as unknown as PointsRules;
}
