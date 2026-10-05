export type PointsOperation = {
  id: string;
  customer_id: string;
  kdt_id: number;
  source_kdt_id: number;
  yz_open_id: string;
  kind: "debit" | "refund";
  points: number;
};
export type PointsOperationResult =
  | { kind: "succeeded" }
  | { kind: "blocked" | "unknown"; reason: string };
export type PointsOperationDeps = {
  writesEnabled(): boolean;
  customerAllowed(customerId: string): boolean;
  proxyConfigured(): boolean;
  resolveHeadquartersToken(kdtId: number, sourceKdtId: number): Promise<string | null>;
  fetchImpl(url: string, init: RequestInit): Promise<Response>;
};

export type PointsOperationStore = {
  claim(id: string): Promise<(PointsOperation & { claim_token: string }) | null>;
  finish(id: string, claimToken: string, result: PointsOperationResult): Promise<boolean>;
};

export async function processPointsOperation(
  id: string, store: PointsOperationStore, execute: (operation: PointsOperation) => Promise<PointsOperationResult>,
): Promise<PointsOperationResult | { kind: "not_claimed" | "unconfirmed" }> {
  const operation = await store.claim(id);
  if (!operation) return { kind: "not_claimed" };
  let result: PointsOperationResult;
  try { result = await execute(operation); }
  catch { result = { kind: "unknown", reason: "remote_result_unconfirmed" }; }
  try {
    if (await store.finish(operation.id, operation.claim_token, result)) return result;
  } catch { /* The next claimant must retry this same operation, not compensate it. */ }
  return { kind: "unconfirmed" };
}

// Caller must first claim a durable operation. A timeout is not a failed debit:
// retry the same operation ID, and never refund until success is confirmed.
export function createYouzanPointsOperation(deps: PointsOperationDeps) {
  return async (operation: PointsOperation): Promise<PointsOperationResult> => {
    if (!deps.writesEnabled() || !deps.customerAllowed(operation.customer_id)) {
      return { kind: "blocked", reason: "points_write_not_enabled" };
    }
    if (!deps.proxyConfigured()) return { kind: "blocked", reason: "fixed_proxy_not_configured" };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operation.id) ||
      !["debit", "refund"].includes(operation.kind) || !Number.isSafeInteger(operation.points) ||
      operation.points < 1 || operation.points > 2147483647 || !operation.yz_open_id?.trim() ||
      !Number.isSafeInteger(operation.kdt_id) || operation.kdt_id <= 0 ||
      !Number.isSafeInteger(operation.source_kdt_id) || operation.source_kdt_id <= 0) {
      return { kind: "blocked", reason: "invalid_points_operation" };
    }
    let token: string | null;
    try { token = await deps.resolveHeadquartersToken(operation.kdt_id, operation.source_kdt_id); }
    catch { token = null; }
    if (!token) return { kind: "blocked", reason: "headquarters_token_unavailable" };
    const method = operation.kind === "debit" ? "decrease" : "increase";
    const params = {
      user: { account_id: operation.yz_open_id, account_type: 5 },
      points: operation.points,
      biz_value: `boomer-points:${operation.id}`,
      biz_token: operation.kind,
      reason: operation.kind === "debit" ? "BOOMER ERP points redemption" : "BOOMER ERP points refund",
      is_do_ext_point: false,
      check_customer: true,
      source_kdt_id: operation.source_kdt_id,
    };
    try {
      const response = await deps.fetchImpl(
        `https://open.youzanyun.com/api/youzan.crm.customer.points.${method}/4.0.0?access_token=${encodeURIComponent(token)}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ params }),
          signal: AbortSignal.timeout(15000) },
      );
      if (response.ok) {
        const json = await response.json();
        if (json?.code === 200 && json.success === true && !json.error_response && !json.gw_err_resp &&
          (json.data?.is_success === true || json.data?.is_success === "true")) {
          return { kind: "succeeded" };
        }
      }
    } catch { /* Do not expose tokens, member identifiers or provider response bodies. */ }
    return { kind: "unknown", reason: "remote_result_unconfirmed" };
  };
}
