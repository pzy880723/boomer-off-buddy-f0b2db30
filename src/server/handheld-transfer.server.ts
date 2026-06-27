// Shared transfer scan helpers
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { type DeviceContext, ok, err } from "@/server/handheld-auth.server";
import { TransferScanReq, TransferConfirmReq } from "@/lib/handheld/schemas";

// 兼容现有路由 import 名
export const ScanBody = TransferScanReq;
export const ConfirmBody = TransferConfirmReq;

export async function getTransfer(id: string) {
  const { data } = await supabaseAdmin
    .from("stock_transfers")
    .select(
      "id, status, from_location_id, to_location_id, lines:stock_transfer_lines(sku_id, expected_qty, shipped_qty, received_qty)"
    )
    .eq("id", id)
    .maybeSingle();
  return data;
}

export async function recordScan(
  side: "ship" | "receive",
  transferId: string,
  epcs: string[],
  device: DeviceContext
) {
  const cleaned = Array.from(new Set(epcs.map((s) => s.trim()).filter(Boolean)));
  const { data: known } = await supabaseAdmin
    .from("inv_epcs")
    .select("epc, sku_id")
    .in("epc", cleaned);
  const knownMap = new Map<string, string | null>();
  (known ?? []).forEach((r: any) => knownMap.set(r.epc, r.sku_id));

  const now = new Date().toISOString();
  for (const epc of cleaned) {
    const sku_id = knownMap.get(epc) ?? null;
    const patch: Record<string, unknown> = { sku_id };
    if (side === "ship") patch.ship_scanned_at = now;
    else patch.receive_scanned_at = now;
    await supabaseAdmin
      .from("stock_transfer_epcs")
      .upsert(
        { transfer_id: transferId, epc, ...patch },
        { onConflict: "transfer_id,epc" }
      );
  }
  const unknown = cleaned.filter((e) => !knownMap.has(e));
  return { received: cleaned.length, unknown_count: unknown.length, unknown };
}

export { ok, err };
