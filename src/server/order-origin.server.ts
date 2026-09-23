export async function recordOrderOrigin(
  store: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{data: unknown; error: {message: string} | null}> },
  input: {orderId: string; customerId: string; platform?: string; evidence?: string},
) {
  if (!input.platform) return null;
  if (!["miniapp", "app", "web"].includes(input.platform)) throw new Error("Unsupported order source");
  const {data, error} = await store.rpc("commerce_record_order_origin", {
    p_order_id: input.orderId,
    p_customer_id: input.customerId,
    p_platform: input.platform,
    p_evidence: input.evidence ?? "client_reported",
  });
  if (error) throw new Error(error.message);
  return data;
}
