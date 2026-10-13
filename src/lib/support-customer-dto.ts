// Customer-facing support conversation DTO: strict whitelist, no staff/contact/internal fields.
export type SafeCustomerContext = { [key: string]: string | number | boolean } | null;
export type LocationNameMap = ReadonlyMap<string, { name: string | null }>;

const CONTEXT_KEYS = ["type", "id", "title", "order_no", "price", "sku_code"] as const;

export function customerSafeContext(raw: unknown): SafeCustomerContext {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: { [key: string]: string | number | boolean } = {};
  for (const k of CONTEXT_KEYS) {
    const v = r[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** null location → HQ; a store location always stays a store, even if its row is missing or unnamed. */
export function customerServiceName(locationId: string | null | undefined, locations: LocationNameMap): string {
  if (!locationId) return "总部客服";
  const name = locations.get(locationId)?.name?.trim();
  return name ? `${name}客服` : "门店客服";
}

export const CUSTOMER_LIST_FIELDS = [
  "id", "title", "status", "location_id", "order_id", "last_message_at", "last_message_preview",
  "updated_at", "context", "service_name",
] as const;

export type CustomerConversationListItem = {
  id: string; title: string | null; status: string | null; location_id: string | null; order_id: string | null;
  last_message_at: string | null; last_message_preview: string | null; updated_at: string | null;
  context: SafeCustomerContext; service_name: string;
};

const str = (v: unknown) => (typeof v === "string" ? v : null);

export function toCustomerConversationListItem(row: Record<string, unknown>, locations: LocationNameMap): CustomerConversationListItem {
  const locationId = str(row.location_id);
  return {
    id: String(row.id), title: str(row.title), status: str(row.status), location_id: locationId,
    order_id: str(row.order_id), last_message_at: str(row.last_message_at),
    last_message_preview: str(row.last_message_preview), updated_at: str(row.updated_at),
    context: customerSafeContext(row.context), service_name: customerServiceName(locationId, locations),
  };
}
