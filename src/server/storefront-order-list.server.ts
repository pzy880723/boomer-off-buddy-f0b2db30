// 订单列表（按门店分组展示）的纯逻辑。
// 不引入 supabase client，便于单测；取数与批量签名在 storefront-order-list-query.server.ts。
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

/** 展示状态：退款三态互不混淆，小程序按真实枚举映射文案。 */
export type DisplayStatus =
  | "pending_payment"
  | "paid"
  | "shipped"
  | "completed"
  | "cancelled"
  | "refunding"
  | "partially_refunded"
  | "refunded";

export type SkuImageSource = { image_paths?: unknown; image_url?: string | null } | null;

export type OrderItemRow = {
  id: string;
  location_id: string | null;
  title_snapshot: string | null;
  image_snapshot: string | null;
  unit_price: number | string | null;
  quantity: number | null;
  line_total: number | string | null;
  listing_id?: string | null;
  sku_id?: string | null;
  /** commerce_order_items.sku_id → inv_skus（真实外键，嵌套批量取，不 N+1） */
  sku?: SkuImageSource;
  listing?: { image_paths?: unknown; cover_url?: string | null; sku?: SkuImageSource } | null;
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
  courier_provider?: string | null;
  courier_service_code?: string | null;
  paid_at?: string | null;
  created_at: string;
  courier_quote_snapshot?: unknown;
  items?: OrderItemRow[] | null;
  fulfillments?: OrderFulfillmentRow[] | null;
};

export type StoreInfo = { store_id: string | null; store_name: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 严格 ISO 白名单：保留到微秒（1-6 位小数），不截断精度。
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

const REFUND_STATUS_MAP: Record<string, DisplayStatus> = {
  refund_pending: "refunding",
  partially_refunded: "partially_refunded",
  refunded: "refunded",
};
const CANCELLED_ORDER_STATUSES = new Set(["cancelled", "closed"]);
/** 履约推进顺序；同一门店多条履约取“最不推进”的一条，结果确定不随机。 */
export const FULFILLMENT_PROGRESS: readonly string[] = [
  "exception",
  "unallocated",
  "allocated",
  "picking",
  "picked",
  "packing",
  "packed",
  "handover_ready",
  "handed_over",
];
/** 终态展示状态：整单状态覆盖门店履约状态。 */
const TERMINAL_DISPLAY = new Set<DisplayStatus>([
  "completed",
  "cancelled",
  "refunding",
  "partially_refunded",
  "refunded",
]);

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
  if (!ISO_RE.test(createdAt) || !UUID_RE.test(id)) throw new Error("Invalid cursor");
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

/** 同一门店的多条履约取推进度最低的一条。 */
export function leastAdvancedStatus(statuses: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const raw of statuses) {
    const status = String(raw ?? "").trim();
    if (!status) continue;
    const idx = FULFILLMENT_PROGRESS.indexOf(status);
    const rank = idx === -1 ? -1 : idx; // 未知状态视为最不推进
    if (rank < bestRank) {
      bestRank = rank;
      best = status;
    }
  }
  return best;
}

/** location_id → 该门店的有效履约状态（多条取最不推进） */
export function fulfillmentStatusByLocation(order: OrderRow): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const f of order.fulfillments ?? []) {
    if (!f.location_id) continue;
    const arr = grouped.get(f.location_id) ?? [];
    arr.push(String(f.status ?? ""));
    grouped.set(f.location_id, arr);
  }
  const out = new Map<string, string>();
  for (const [locationId, statuses] of grouped) {
    const status = leastAdvancedStatus(statuses);
    if (status) out.set(locationId, status);
  }
  return out;
}

/** 明细涉及的全部门店 */
export function itemLocationIds(order: OrderRow): string[] {
  return Array.from(
    new Set((order.items ?? []).map((i) => i.location_id).filter((id): id is string => !!id)),
  );
}

export function deriveDisplayStatus(order: OrderRow): DisplayStatus {
  const payment = String(order.payment_status ?? "");
  const status = String(order.order_status ?? "");
  const refund = REFUND_STATUS_MAP[payment];
  if (refund) return refund;
  if (CANCELLED_ORDER_STATUSES.has(status)) return "cancelled";
  if (status === "completed") return "completed";
  if (payment === "paid") {
    const locations = itemLocationIds(order);
    const byLocation = fulfillmentStatusByLocation(order);
    // 已发货 = 明细涉及的**每个**门店都有履约且都已交接；无明细门店信息时回落履约行本身
    const covered =
      locations.length > 0
        ? locations.every((id) => byLocation.get(id) === "handed_over")
        : (order.fulfillments ?? []).length > 0 &&
          Array.from(byLocation.values()).every((s) => s === "handed_over");
    return covered ? "shipped" : "paid";
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
  return snapshotGroups(snapshot).find((g) => String(g?.location_id ?? "") === locationId) ?? null;
}

export function snapshotStoreName(snapshot: unknown, locationId: string | null): string | null {
  const name = groupFor(snapshot, locationId)?.store_name;
  const text = typeof name === "string" ? name.trim() : "";
  return text || null;
}

/**
 * 历史按店运费（分）；没有可核实的历史值返回 null —— 绝不平均分摊，
 * 也绝不把 null / "" / 非数值当成 0（包邮）。
 */
export function snapshotShippingFeeFen(snapshot: unknown, locationId: string | null): number | null {
  const value = groupFor(snapshot, locationId)?.shipping_fee_fen;
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  else return null;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
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
  courier_provider: string | null;
  courier_service_code: string | null;
  paid_at: string | null;
  created_at: string;
  shops: ShopGroup[];
};

export type AssembleContext = {
  /** location_id → 门店信息（inv_locations + youzan_shops） */
  stores: Map<string, StoreInfo>;
  /** order_item.id → 已签名可直接展示的图片 URL */
  images: Map<string, string | null>;
};

/** 门店维度状态：整单终态（完成/取消/退款三态）优先于门店履约状态。 */
export function deriveShopStatus(display: DisplayStatus, fulfillmentStatus: string | null): string {
  if (TERMINAL_DISPLAY.has(display)) return display;
  if (fulfillmentStatus) return fulfillmentStatus;
  return display === "pending_payment" ? "pending_payment" : "unallocated";
}

export function buildOrderListItem(order: OrderRow, ctx: AssembleContext): OrderListItem {
  const display = deriveDisplayStatus(order);
  const fulfillmentByLocation = fulfillmentStatusByLocation(order);

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
    courier_provider: order.courier_provider ?? null,
    courier_service_code: order.courier_service_code ?? null,
    paid_at: order.paid_at ?? null,
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
 * 键集分页 + JS 精筛。粗筛在 SQL，shipped/paid 的拆分需要履约行，所以按批扫描。
 * 关键：即使本页一条都没匹配上，只要还没扫到底，也返回“扫描进度游标”和 has_more=true，
 * 前端继续翻页即可拿到后面的匹配订单 —— 不漏、不重。
 */
export async function selectOrdersPage(
  fetchBatch: BatchFetcher,
  query: OrdersListQuery,
  options: { batchSize?: number; maxRounds?: number } = {},
): Promise<{ rows: OrderRow[]; hasMore: boolean; nextCursor: string | null }> {
  const batchSize = options.batchSize ?? Math.max(query.limit * 2, 40);
  const maxRounds = options.maxRounds ?? 5;
  const matched: OrderRow[] = [];
  let scanCursor = query.cursor;
  let exhausted = false;

  for (let round = 0; round < maxRounds && matched.length <= query.limit; round += 1) {
    const batch = await fetchBatch({ cursor: scanCursor, size: batchSize });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of batch) {
      if (matchesStatusFilter(row, query.status)) matched.push(row);
    }
    const last = batch[batch.length - 1]!;
    scanCursor = { created_at: last.created_at, id: last.id };
    if (batch.length < batchSize) {
      exhausted = true;
      break;
    }
  }

  const rows = matched.slice(0, query.limit);
  if (matched.length > query.limit) {
    // 还有已扫描但未输出的匹配订单：游标必须停在最后一条已输出订单上
    const lastEmitted = rows[rows.length - 1]!;
    return { rows, hasMore: true, nextCursor: encodeOrderCursor(lastEmitted) };
  }
  if (!exhausted && scanCursor) {
    // 未扫到底（含本页 0 匹配）：交回扫描进度游标，前端可继续翻
    return { rows, hasMore: true, nextCursor: encodeOrderCursor(scanCursor) };
  }
  return { rows, hasMore: false, nextCursor: null };
}

/* -------------------------------- images ------------------------------- */

export type ImageRef = { kind: "direct"; value: string } | { kind: "path"; value: string } | null;

function classifyImageValue(raw: unknown): ImageRef {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return { kind: "direct", value };
  if (value.includes("/")) return { kind: "path", value };
  return null;
}

function fromImageList(raw: unknown): ImageRef {
  if (!Array.isArray(raw)) return null;
  for (const value of raw) {
    const ref = classifyImageValue(value);
    if (ref) return ref;
  }
  return null;
}

function fromSku(sku: SkuImageSource): ImageRef {
  if (!sku) return null;
  return fromImageList(sku.image_paths) ?? classifyImageValue(sku.image_url ?? null);
}

/**
 * 单条明细的图源回退链（与 commerce-listing / storefront-products 的真实字段一致）：
 * image_snapshot → listing.image_paths → listing.cover_url → SKU.image_paths → SKU.image_url
 * SKU 源来自 commerce_order_items.sku_id（真实外键）或 listing.sku_id，嵌套批量取。
 */
export function resolveItemImageRef(item: OrderItemRow): ImageRef {
  return (
    classifyImageValue(item.image_snapshot) ??
    fromImageList(item.listing?.image_paths) ??
    classifyImageValue(item.listing?.cover_url ?? null) ??
    fromSku(item.sku ?? null) ??
    fromSku(item.listing?.sku ?? null)
  );
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
