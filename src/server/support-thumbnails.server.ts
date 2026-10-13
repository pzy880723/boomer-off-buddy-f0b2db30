// Customer support list thumbnails: read-time only, batched, derivative-only (never originals or keys).
// Product chat → server-set listing first image; order chat → first item with a signable derivative,
// only for orders re-verified as owned by this customer. HQ / no image → null (client shows brand logo).
import { resolveItemImageRef } from "./storefront-order-list.server";

type Row = { id: unknown; order_id?: unknown; context?: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryClient = { from: (table: string) => any };
export type ThumbnailDeps = { client?: QueryClient; sign?: (paths: readonly string[]) => Promise<(string | null)[]> };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const ctx = (row: Row) => (row.context && typeof row.context === "object" ? row.context as Record<string, unknown> : null);

async function defaultSign(paths: readonly string[]) {
  const { DERIVATIVE_WIDTHS, signDerivativeUrls } = await import("./media-derivative.server");
  try { return await signDerivativeUrls(paths, DERIVATIVE_WIDTHS.thumbnail); } catch { return paths.map(() => null); }
}

export async function loadConversationThumbnails(rows: readonly Row[], customerId: string, deps: ThumbnailDeps = {}) {
  const out = new Map<string, string | null>(rows.map((r) => [String(r.id), null]));
  const productOf = new Map<string, string>(), orderOf = new Map<string, string>();
  for (const r of rows) {
    const c = ctx(r);
    const orderId = str(r.order_id) ?? (c?.type === "order" ? str(c.id) : null);
    if (orderId) orderOf.set(String(r.id), orderId);
    else if (c?.type === "product" && str(c.id)) productOf.set(String(r.id), str(c.id)!);
  }
  if (!productOf.size && !orderOf.size) return out;
  const client = deps.client ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin as unknown as QueryClient;
  const sign = deps.sign ?? defaultSign;

  const listingIds = [...new Set(productOf.values())];
  const orderIds = [...new Set(orderOf.values())];
  const [listingRes, ownedRes] = await Promise.all([
    listingIds.length ? client.from("commerce_listings").select("id,image_paths,cover_url").in("id", listingIds) : { data: [] },
    orderIds.length ? client.from("commerce_orders").select("id").eq("customer_id", customerId).in("id", orderIds) : { data: [] },
  ]);
  const owned = ((ownedRes.data ?? []) as { id: string }[]).map((o) => o.id);
  const itemRes = owned.length
    ? await client.from("commerce_order_items")
      .select("id,order_id,created_at,image_snapshot,sku:inv_skus(image_paths,image_url),listing:commerce_listings(image_paths,cover_url)")
      .in("order_id", owned).order("created_at", { ascending: true }).order("id", { ascending: true })
    : { data: [] };

  // Candidate bucket/path refs only; one batched derivative sign for the whole page.
  const listingRef = new Map<string, string>();
  for (const l of (listingRes.data ?? []) as Record<string, unknown>[]) {
    const ref = resolveItemImageRef({ id: String(l.id), listing: l } as never);
    if (ref?.kind === "path") listingRef.set(String(l.id), ref.value);
  }
  const itemRefs = new Map<string, string[]>();
  for (const it of (itemRes.data ?? []) as Record<string, unknown>[]) {
    const ref = resolveItemImageRef(it as never);
    if (ref?.kind !== "path") continue;
    const list = itemRefs.get(String(it.order_id)) ?? [];
    list.push(ref.value); itemRefs.set(String(it.order_id), list);
  }
  const paths = [...new Set([...listingRef.values(), ...[...itemRefs.values()].flat()])];
  const signed = paths.length ? await sign(paths) : [];
  const byPath = new Map(paths.map((p, i) => [p, signed[i] ?? null]));

  for (const [convId, listingId] of productOf) out.set(convId, byPath.get(listingRef.get(listingId) ?? "") ?? null);
  for (const [convId, orderId] of orderOf) {
    const first = (itemRefs.get(orderId) ?? []).map((p) => byPath.get(p) ?? null).find((u) => !!u) ?? null;
    out.set(convId, first);
  }
  return out;
}
