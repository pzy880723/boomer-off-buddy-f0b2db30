// 订单列表（按门店分组展示）的纯逻辑。
// 不引入 supabase client，便于单测；路由负责取数 + 批量签名后调用这里组装。
//
// 关键约束：
// - 不是真实子订单：shops[] 只是按 commerce_order_items.location_id 的展示分组
// - 总金额唯一来自 commerce_orders.total_amount
// - 按店运费唯一真源 courier_quote_snapshot.groups[].shipping_fee_fen，缺失为 null（不摊派）
// - 子单 subtotal_fen 只是商品小计，不含运费/优惠，不代表实付
// - 不下发地址/手机号/EPC/支付快照/规格占位

export type OrderListStatus = "all" | "pending_payment" | "paid" | "shipped" | "completed";

export const ORDER_LIST_STATUSES: readonly OrderListStatus[] = [
  "all",
  "pending_payment",
  "paid",
  "shipped",
  "completed",
];

export type DisplayStatus =
  | "pending_payment"
  | "paid"
  | "shipped"
  | "completed"
  | "cancelled"
  | "refunded";

export type OrderItemRow = {
  id: string;
  location_id: string | null;
  title_snapshot: string | null;
  image_snapshot: string | null;
  unit_price: number | string | null;
  quantity: number | null;
  line_total: number | string | null;
  listing_id: string | null;
  listing?: { image_paths?: unknown; cover_url?: string | null } | null;
};

export type OrderFulfillmentRow = { location_id: string | null; status: string | null };

export type OrderRow = {
  id: string;
  order_no: string | null;
  order_status: string | null;
  payment_status: string | null;
  total_amount: number | string | null;
  shipping_fee?: number | string | null;
  discount_total?: number | string | null;
  currency?: string | null;
  created_at: string;
  courier_quote_snapshot?: unknown;
  items?: OrderItemRow[] | null;
  fulfillments?: OrderFulfillmentRow[] | null;
};

export type StoreInfo = { store_id: string | null; store_name: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDED_OVER = new Set(["handed_over"]);
const REFUND_PAYMENT_STATUSES = new Set(["refund_pending", "partially_refunded", "refunded"]);
const CANCELLED_ORDER_STATUSES = new Set(["cancelled", "closed"]);

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/* ------------------------------- cursor ------------------------------- */

export type OrderCursor = { created_at: string; id: string };

export function encodeOrderCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(`${row.created_at}|${row.id}`, "utf8").toString("base64url");
}

/** 解析游标；任何非法/被篡改的值抛错（由路由转 400），绝不拼进 SQL。 */
export function decodeOrderCursor(raw: string): OrderCursor {
  let decoded = "";
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid cursor");
  }
  const sep = decoded.indexOf("|");
  if (sep <= 0) throw new Error("Invalid cursor");
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!UUID_RE.test(id)) throw new Error("Invalid cursor");
  const ts = new Date(createdAt);
  if (!createdAt || Number.isNaN(ts.getTime()) || createdAt.includes(",") || createdAt.includes(")")) {
    throw new Error("Invalid cursor");
  }
  return { created_at: createdAt, id };
}

export type OrdersListQuery = { status: OrderListStatus; limit: number; cursor: OrderCursor | null };

export function parseOrdersListQuery(url: URL): OrdersListQuery {
  const rawStatus = (url.searchParams.get("status") ?? "all").trim();
  if (!ORDER_LIST_STATUSES.includes(rawStatus as OrderListStatus)) {
    throw new Error("Invalid status");
  }
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_PAGE_SIZE;
  if (rawLimit != null && rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) throw new Error("Invalid limit");
    limit = n;
  }
  const rawCursor = url.searchParams.get("cursor");
  return {
    status: rawStatus as OrderListStatus,
    limit,
    cursor: rawCursor ? decodeOrderCursor(rawCursor) : null,
  };
}

/* ------------------------------- status ------------------------------- */

export function deriveDisplayStatus(order: OrderRow): DisplayStatus {
  const payment = String(order.payment_status ?? "");
  const status = String(order.order_status ?? "");
  if (REFUND_PAYMENT_STATUSES.has(payment)) return "refunded";
  if (CANCELLED_ORDER_STATUSES.has(status)) return "cancelled";
  if (status === "completed") return "completed";
  if (payment === "paid") {
    const fulfillments = order.fulfillments ?? [];
    const shipped =
      fulfillments.length > 0 && fulfillments.every((f) => HANDED_OVER.has(String(f.status ?? "")));
    return shipped ? "shipped" : "paid";
  }
  return "pending_payment";
}

export function matchesStatusFilter(order: OrderRow, status: OrderListStatus): boolean {
  if (status === "all") return true;
  return deriveDisplayStatus(order) === status;
}

/** SQL 粗筛：只用订单表列，精筛（shipped/paid 拆分）在 JS。 */
export function coarseStatusFilter(status: OrderListStatus): {
  orderStatuses?: string[];
  paymentStatuses?: string[];
} {
  switch (status) {
    case "pending_payment":
      return { orderStatuses: ["pending_payment"], paymentStatuses: ["unpaid"] };
    case "paid":
    case "shipped":
      return { orderStatuses: ["confirmed", "processing"], paymentStatuses: ["paid"] };
    case "completed":
      return { orderStatuses: ["completed"] };
    default:
      return {};
  }
}

/* ------------------------------ snapshot ------------------------------ */

type SnapshotGroup = {
  location_id?: unknown;
  store_name?: unknown;
  shipping_fee_fen?: unknown;
};

function snapshotGroups(snapshot: unknown): SnapshotGroup[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const groups = (snapshot as { groups?: unknown }).groups;
  return Array.isArray(groups) ? (groups as SnapshotGroup[]) : [];
}

function groupFor(snapshot: unknown, locationId: string | null): SnapshotGroup | null {
  if (!locationId) return null;
  return (
    snapshotGroups(snapshot).find((g) => String(g?.location_id ?? "") === locationId) ?? null
  );
}

export function snapshotStoreName(snapshot: unknown, locationId: string | null): string | null {
  const name = groupFor(snapshot, locationId)?.store_name;
  const text = typeof name === "string" ? name.trim() : "";
  return text || null;
}

/** 历史按店运费（分）；没有历史值返回 null —— 绝不平均分摊。 */
export function snapshotShippingFeeFen(snapshot: unknown, locationId: string | null): number | null {
  const value = groupFor(snapshot, locationId)?.shipping_fee_fen;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/* ------------------------------ assembling ---------------------------- */

function toYuan(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function toFen(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export type ShopGroup = {
  location_id: string | null;
  store_id: string | null;
  store_name: string | null;
  status: string;
  shipping_fee_fen: number | null;
  subtotal_fen: number | null;
  items: Array<{
    id: string;
    title: string | null;
    image_url: string | null;
    unit_price: number;
    quantity: number;
    line_total: number;
  }>;
};

export type OrderListItem = {
  id: string;
  order_no: string | null;
  order_status: string | null;
  payment_status: string | null;
  display_status: DisplayStatus;
  total_amount: number;
  shipping_fee: number;
  discount_amount: number;
  currency: string;
  created_at: string;
  shops: ShopGroup[];
};

export type AssembleContext = {
  /** location_id → 门店信息（inv_locations + youzan_shops） */
  stores: Map<string, StoreInfo>;
  /** order_item.id → 已签名可直接展示的图片 URL */
  images: Map<string, string | null>;
};

/** 门店维度状态：取消/退款优先于履约状态。 */
export function deriveShopStatus(
  display: DisplayStatus,
  fulfillmentStatus: string | null,
): string {
  if (display === "cancelled" || display === "refunded") return display;
  if (fulfillmentStatus) return fulfillmentStatus;
  return display === "pending_payment" ? "pending_payment" : "unallocated";
}

export function buildOrderListItem(order: OrderRow, ctx: AssembleContext): OrderListItem {
  const display = deriveDisplayStatus(order);
  const fulfillmentByLocation = new Map<string, string>();
  for (const f of order.fulfillments ?? []) {
    if (f.location_id && !fulfillmentByLocation.has(f.location_id)) {
      fulfillmentByLocation.set(f.location_id, String(f.status ?? ""));
    }
  }

  const grouped = new Map<string, ShopGroup>();
  for (const item of order.items ?? []) {
    const locationId = item.location_id ?? null;
    const key = locationId ?? "__unknown__";
    let group = grouped.get(key);
    if (!group) {
      const store = locationId ? ctx.stores.get(locationId) : undefined;
      group = {
        location_id: locationId,
        store_id: store?.store_id ?? null,
        store_name:
          snapshotStoreName(order.courier_quote_snapshot, locationId) ?? store?.store_name ?? null,
        status: deriveShopStatus(
          display,
          locationId ? (fulfillmentByLocation.get(locationId) ?? null) : null,
        ),
        shipping_fee_fen: snapshotShippingFeeFen(order.courier_quote_snapshot, locationId),
        subtotal_fen: 0,
        items: [],
      };
      grouped.set(key, group);
    }
    group.items.push({
      id: item.id,
      title: item.title_snapshot ?? null,
      image_url: ctx.images.get(item.id) ?? null,
      unit_price: toYuan(item.unit_price),
      quantity: Number(item.quantity ?? 0) || 0,
      line_total: toYuan(item.line_total),
    });
    group.subtotal_fen = (group.subtotal_fen ?? 0) + toFen(item.line_total);
  }

  return {
    id: order.id,
    order_no: order.order_no ?? null,
    order_status: order.order_status ?? null,
    payment_status: order.payment_status ?? null,
    display_status: display,
    total_amount: toYuan(order.total_amount),
    shipping_fee: toYuan(order.shipping_fee),
    discount_amount: toYuan(order.discount_total),
    currency: order.currency ?? "CNY",
    created_at: order.created_at,
    shops: Array.from(grouped.values()),
  };
}

/* ------------------------------ pagination ---------------------------- */

export type BatchFetcher = (args: {
  cursor: OrderCursor | null;
  size: number;
}) => Promise<OrderRow[]>;

/**
 * 键集分页 + JS 精筛。粗筛在 SQL，shipped/paid 的拆分需要履约行，
 * 所以按批取数直到凑满一页（最多 MAX_ROUNDS 轮），游标始终取自最后一条已输出订单。
 */
export async function selectOrdersPage(
  fetchBatch: BatchFetcher,
  query: OrdersListQuery,
  options: { batchSize?: number; maxRounds?: number } = {},
): Promise<{ rows: OrderRow[]; hasMore: boolean; nextCursor: string | null }> {
  const batchSize = options.batchSize ?? Math.max(query.limit * 2, 40);
  const maxRounds = options.maxRounds ?? 5;
  const matched: OrderRow[] = [];
  let cursor = query.cursor;
  let exhausted = false;

  for (let round = 0; round < maxRounds && matched.length <= query.limit; round += 1) {
    const batch = await fetchBatch({ cursor, size: batchSize });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of batch) {
      if (matchesStatusFilter(row, query.status)) matched.push(row);
    }
    const last = batch[batch.length - 1]!;
    cursor = { created_at: last.created_at, id: last.id };
    if (batch.length < batchSize) {
      exhausted = true;
      break;
    }
  }

  const hasMore = matched.length > query.limit || (!exhausted && matched.length === query.limit);
  const rows = matched.slice(0, query.limit);
  const lastRow = rows[rows.length - 1];
  return {
    rows,
    hasMore,
    nextCursor: hasMore && lastRow ? encodeOrderCursor(lastRow) : null,
  };
}

/* -------------------------------- images ------------------------------- */

export type ImageRef =
  | { kind: "direct"; value: string }
  | { kind: "path"; value: string }
  | null;

function classifyImageValue(raw: unknown): ImageRef {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return { kind: "direct", value };
  if (value.includes("/")) return { kind: "path", value };
  return null;
}

/** 单条明细的图源：image_snapshot 优先，缺失回退关联 listing 的首图 / 封面。 */
export function resolveItemImageRef(item: OrderItemRow): ImageRef {
  const snapshot = classifyImageValue(item.image_snapshot);
  if (snapshot) return snapshot;
  const paths = item.listing?.image_paths;
  if (Array.isArray(paths)) {
    for (const p of paths) {
      const ref = classifyImageValue(p);
      if (ref) return ref;
    }
  }
  return classifyImageValue(item.listing?.cover_url ?? null);
}

/** 拍平整页所有明细的图源，返回 itemId→ref 与需要签名的去重路径列表。 */
export function collectImageRefs(orders: readonly OrderRow[]): {
  refs: Map<string, ImageRef>;
  paths: string[];
} {
  const refs = new Map<string, ImageRef>();
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const order of orders) {
    for (const item of order.items ?? []) {
      const ref = resolveItemImageRef(item);
      refs.set(item.id, ref);
      if (ref?.kind === "path" && !seen.has(ref.value)) {
        seen.add(ref.value);
        paths.push(ref.value);
      }
    }
  }
  return { refs, paths };
}

/** 把批量签名结果回填成 itemId→URL；签名失败为 null（前端占位，不泄露路径）。 */
export function buildImageMap(
  refs: Map<string, ImageRef>,
  paths: readonly string[],
  signed: readonly (string | null)[],
): Map<string, string | null> {
  const byPath = new Map<string, string | null>();
  paths.forEach((p, i) => byPath.set(p, signed[i] ?? null));
  const out = new Map<string, string | null>();
  for (const [itemId, ref] of refs) {
    if (!ref) out.set(itemId, null);
    else if (ref.kind === "direct") out.set(itemId, ref.value);
    else out.set(itemId, byPath.get(ref.value) ?? null);
  }
  return out;
}
