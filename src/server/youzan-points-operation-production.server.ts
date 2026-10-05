import { DatabaseSync } from "node:sqlite";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { youzanFetch } from "@/lib/youzan-http";
import { selectPointsHeadquarters } from "./youzan-points-query.server";
import { createYouzanPointsOperation, processPointsOperation, type PointsOperationStore } from "./youzan-points-operation.server";

export type PointsOperationInput = {
  operationKey: string; customerId: string; sourceKdtId: number;
  kind: "debit" | "refund"; points: number; parentId?: string;
};

const allowed = (customerId: string) => process.env.YOUZAN_POINTS_WRITE_ENABLED === "true" &&
  (process.env.YOUZAN_POINTS_WRITE_CUSTOMER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean).includes(customerId);
const proxyConfigured = () => /^https?:\/\//i.test(process.env.YOUZAN_PROXY_URL?.trim() ?? "") &&
  !!process.env.YOUZAN_PROXY_TOKEN?.trim();

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(name as never, args as never);
  if (error) throw Error("points_operation_store_unavailable");
  return data as unknown;
}

export const productionPointsOperationStore: PointsOperationStore = {
  async claim(id) {
    return await rpc("youzan_points_operation_claim", { p_id: id }) as Awaited<ReturnType<PointsOperationStore["claim"]>>;
  },
  async finish(id, token, result) {
    return await rpc("youzan_points_operation_finish", {
      p_id: id, p_claim_token: token, p_status: result.kind,
      p_reason: result.kind === "succeeded" ? null : result.reason,
    }) === true;
  },
};

// Internal server entry only. No public mutation route or scheduled spending worker.
// The existing channel identity map is read-only and checked again before dispatch.
export async function runProductionPointsOperation(input: PointsOperationInput) {
  if (!allowed(input.customerId)) return { kind: "blocked", reason: "points_write_not_enabled" } as const;
  if (!proxyConfigured()) {
    return { kind: "blocked", reason: "fixed_proxy_not_configured" } as const;
  }
  const { data: shops, error } = await supabaseAdmin.from("youzan_shops")
    .select("kdt_id,parent_kdt_id,role,status,access_token,token_expires_at").eq("status", "active");
  if (error) throw Error("points_shop_lookup_failed");
  const head = selectPointsHeadquarters(shops ?? [], input.sourceKdtId);
  if (!head) return { kind: "blocked", reason: "headquarters_token_unavailable" } as const;
  const db = new DatabaseSync(process.env.YOUZAN_MEMBER_LINK_DB || "/var/lib/boomer-off/membership-youzan-links.sqlite", { readOnly: true });
  try {
    const links = db.prepare("SELECT customer_id,kdt_id,yz_id FROM member_channel_links WHERE customer_id=? AND kdt_id IN (?,?)")
      .all(input.customerId, head.kdt_id, input.sourceKdtId) as Array<{ customer_id: string; kdt_id: number; yz_id: string }>;
    if (!links.length || new Set(links.map(l => l.yz_id)).size !== 1 || !links[0].yz_id) {
      return { kind: "blocked", reason: "trusted_member_mapping_missing" } as const;
    }
    const yzId = links[0].yz_id;
    const bindingStillMatches = () => {
      const current = db.prepare("SELECT customer_id,yz_id FROM member_channel_links WHERE (customer_id=? OR yz_id=?) AND kdt_id IN (?,?)")
        .all(input.customerId, yzId, head.kdt_id, input.sourceKdtId) as Array<{ customer_id: string; yz_id: string }>;
      return current.length > 0 && current.every(l => l.customer_id === input.customerId && l.yz_id === yzId);
    };
    const conflicting = db.prepare("SELECT 1 FROM member_channel_links WHERE yz_id=? AND kdt_id IN (?,?) AND customer_id<>? LIMIT 1")
      .get(yzId, head.kdt_id, input.sourceKdtId, input.customerId);
    if (conflicting) return { kind: "blocked", reason: "trusted_member_mapping_conflict" } as const;
    const begun = await rpc("youzan_points_operation_begin", {
      p_operation_key: input.operationKey, p_customer_id: input.customerId,
      p_kdt_id: head.kdt_id, p_source_kdt_id: input.sourceKdtId, p_yz_open_id: yzId,
      p_kind: input.kind, p_points: input.points, p_parent_id: input.parentId ?? null,
    }) as { id: string; status: string };
    if (begun.status === "succeeded") return { kind: "succeeded", operationId: begun.id, duplicate: true } as const;
    const execute = createYouzanPointsOperation({
      writesEnabled: () => allowed(input.customerId),
      customerAllowed: id => id === input.customerId && allowed(id),
      proxyConfigured,
      async resolveHeadquartersToken(kdtId, sourceKdtId) {
        if (kdtId !== head.kdt_id || sourceKdtId !== input.sourceKdtId) return null;
        const { data: customer, error: customerError } = await supabaseAdmin.from("commerce_customers")
          .select("id").eq("id", input.customerId).eq("status", "active").maybeSingle();
        if (customerError || !customer) return null;
        const { data: current, error: currentError } = await supabaseAdmin.from("youzan_shops")
          .select("kdt_id,parent_kdt_id,role,status,access_token,token_expires_at").eq("status", "active");
        if (currentError) return null;
        const fresh = selectPointsHeadquarters(current ?? [], sourceKdtId);
        return fresh?.kdt_id === kdtId && bindingStillMatches() ? fresh.access_token ?? null : null;
      },
      fetchImpl: youzanFetch,
    });
    const result = await processPointsOperation(begun.id, productionPointsOperationStore, operation => {
      if (operation.yz_open_id !== yzId || operation.customer_id !== input.customerId ||
        operation.points !== input.points || operation.kind !== input.kind) {
        return Promise.resolve({ kind: "blocked", reason: "operation_identity_mismatch" } as const);
      }
      if (!bindingStillMatches()) {
        return Promise.resolve({ kind: "blocked", reason: "trusted_member_mapping_conflict" } as const);
      }
      return execute(operation);
    });
    return { ...result, operationId: begun.id, duplicate: false };
  } finally { db.close(); }
}
