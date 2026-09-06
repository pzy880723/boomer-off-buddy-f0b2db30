// 订单中心只读服务：父订单列表/详情 + 履约分页列表。
// 只读现有 commerce_orders / commerce_order_items / fulfillments / fulfillment_items，
// 不新建订单表，不改写任何写接口语义。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadUserRoles } from "@/server/handheld-auth.server";

export type OrderStatusFilter =
  | "all"
  | "pending"
  | "unpaid"
  | "after_sales"
  | "shipped"
  | "completed"
  | "cancelled";

export const ORDER_STATUS_FILTERS: OrderStatusFilter[] = [
  "all",
  "pending",
  "unpaid",
  "after_sales",
  "shipped",
  "completed",
  "cancelled",
];

/** 数据库真实存在的履约状态（fulfillments.status） */
export const FULFILLMENT_DB_STATUSES = [
  "unallocated",
  "allocated",
  "picking",
  "picked",
  "packing",
  "packed",
  "handover_ready",
  "handed_over",
  "exception",
] as const;

export const FULFILLMENT_STATUS_LABELS: Record<string, string> = {
  unallocated: "待分配",
  allocated: "待拣货",
  picking: "拣货中",
  picked: "已拣货",
  packing: "打包中",
  packed: "已打包",
  handover_ready: "待取件",
  handed_over: "已交接",
  exception: "异常",
};

export const ORDER_STATUS_LABELS: Record<OrderStatusFilter, string> = {
  all: "全部",
  pending: "待履约",
  unpaid: "待付款",
  after_sales: "售后中",
  shipped: "已发出",
  completed: "已完成",
  cancelled: "已取消",
};

export function clampPage(raw: string | null): number {
  const n = Number(raw ?? 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

export function clampPageSize(raw: string | null, fallback = 20): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 100);
}

/** 姓名脱敏：张三 -> 张*，Alice -> A***e */
export function maskName(name: string | null | undefined): string | null {
  const value = (name ?? "").trim();
  if (!value) return null;
  if (value.length === 1) return value;
  if (value.length === 2) return `${value[0]}*`;
  return `${value[0]}${"*".repeat(value.length - 2)}${value[value.length - 1]}`;
}

/** 手机号脱敏：13812345678 -> 138****5678 */
export function maskPhone(phone: string | null | undefined): string | null {
  const value = (phone ?? "").replace(/\s+/g, "");
  if (!value) return null;
  if (value.length <= 4) return `${"*".repeat(Math.max(value.length - 2, 0))}${value.slice(-2)}`;
  const head = value.slice(0, Math.min(3, value.length - 4));
  return `${head}${"*".repeat(value.length - head.length - 4)}${value.slice(-4)}`;
}

/** 地址摘要：保留履约必要的省市区 + 街道首段，详细门牌脱敏 */
export function buildAddressSummary(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const region = [pick("province", "state"), pick("city"), pick("district", "county", "area")]
    .filter(Boolean)
    .join("");
  const detail = pick("detail", "address", "street", "address_detail");
  const maskedDetail = detail
    ? detail.length <= 4
      ? detail
      : `${detail.slice(0, 4)}${"*".repeat(Math.min(detail.length - 4, 6))}`
    : "";
  const summary = `${region}${maskedDetail}`.trim();
  return summary || null;
}

export function toAmount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

export type DerivedOrderStatus = Exclude<OrderStatusFilter, "all">;

export function deriveOrderStatus(input: {
  payment_status: string | null;
  order_status: string | null;
  has_handed_over: boolean;
}): DerivedOrderStatus {
  const order = input.order_status ?? "";
  if (order === "cancelled" || order === "closed") return "cancelled";
  if (order === "after_sale") return "after_sales";
  if (order === "completed") return "completed";
  if (input.payment_status !== "paid") return "unpaid";
  if (input.has_handed_over) return "shipped";
  return "pending";
}

export function orderStatusLabel(status: DerivedOrderStatus): string {
  return ORDER_STATUS_LABELS[status];
}

export async function isHqUser(userId: string): Promise<boolean> {
  const roles = await loadUserRoles(userId);
  return roles.includes("super_admin") || roles.includes("hq_operator");
}

async function orderIdsWithHandedOverFulfillment(): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from("fulfillments" as never)
    .select("order_id")
    .eq("status", "handed_over")
    .limit(10000);
  return new Set(((data as { order_id: string }[] | null) ?? []).map((r) => r.order_id));
}

async function orderIdsAtLocation(locationId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("fulfillments" as never)
    .select("order_id")
    .eq("location_id", locationId)
    .limit(10000);
  return Array.from(
    new Set(((data as { order_id: string }[] | null) ?? []).map((r) => r.order_id)),
  );
}

const ORDER_SELECT =
  "id, order_no, payment_status, order_status, created_at, source_channel, subtotal, shipping_fee, discount_total, total_amount, recipient_name, recipient_phone, shipping_address, customer_note, paid_at, fulfillment_method, " +
  "items:commerce_order_items(id, title_snapshot, image_snapshot, unit_price, quantity, line_total, sku:inv_skus!sku_id(barcode, image_url)), " +
  "fulfillments:fulfillments(id, code, location_id, status, created_at, location:inv_locations!location_id(name), items:fulfillment_items(id, expected_qty, picked_qty, order_item:commerce_order_items!order_item_id(id, title_snapshot, image_snapshot, unit_price, quantity), sku:inv_skus!sku_id(name, barcode, image_url)))";

type RawOrderRow = {
  id: string;
  order_no: string;
  payment_status: string | null;
  order_status: string | null;
  created_at: string;
  source_channel: string | null;
  subtotal: number | null;
  shipping_fee: number | null;
  discount_total: number | null;
  total_amount: number | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  shipping_address: unknown;
  customer_note: string | null;
  paid_at: string | null;
  fulfillment_method: string | null;
  items: Array<{
    id: string;
    title_snapshot: string | null;
    image_snapshot: string | null;
    unit_price: number | null;
    quantity: number | null;
    line_total: number | null;
    sku: { barcode: string | null; image_url: string | null } | null;
  }> | null;
  fulfillments: Array<{
    id: string;
    code: string | null;
    location_id: string;
    status: string;
    created_at: string;
    location: { name: string } | null;
    items: Array<{
      id: string;
      expected_qty: number;
      picked_qty: number;
      order_item: {
        id: string;
        title_snapshot: string | null;
        image_snapshot: string | null;
        unit_price: number | null;
        quantity: number | null;
      } | null;
      sku: { name: string | null; barcode: string | null; image_url: string | null } | null;
    }> | null;
  }> | null;
};

function shapeOrder(row: RawOrderRow, detail: boolean) {
  const items = (row.items ?? []).map((item) => ({
    id: item.id,
    title: item.title_snapshot ?? "商品",
    barcode: item.sku?.barcode ?? null,
    image_url: item.image_snapshot ?? item.sku?.image_url ?? null,
    quantity: item.quantity ?? 0,
    unit_price: toAmount(item.unit_price),
  }));
  const hasHandedOver = (row.fulfillments ?? []).some((f) => f.status === "handed_over");
  const status = deriveOrderStatus({
    payment_status: row.payment_status,
    order_status: row.order_status,
    has_handed_over: hasHandedOver,
  });
  const fulfillments = (row.fulfillments ?? []).map((f) => {
    const fItems = f.items ?? [];
    const goods = fItems.reduce(
      (sum, it) => sum + Number(it.order_item?.unit_price ?? 0) * Number(it.expected_qty ?? 0),
      0,
    );
    const base = {
      id: f.id,
      code: f.code,
      location_id: f.location_id,
      location_name: f.location?.name ?? null,
      status: f.status,
      status_label: FULFILLMENT_STATUS_LABELS[f.status] ?? f.status,
      item_count: fItems.reduce((sum, it) => sum + Number(it.expected_qty ?? 0), 0),
      goods_amount: toAmount(goods),
    };
    if (!detail) return base;
    return {
      ...base,
      items: fItems.map((it) => ({
        id: it.id,
        expected_qty: it.expected_qty,
        picked_qty: it.picked_qty,
        title: it.order_item?.title_snapshot ?? it.sku?.name ?? "商品",
        barcode: it.sku?.barcode ?? null,
        image_url: it.order_item?.image_snapshot ?? it.sku?.image_url ?? null,
        unit_price: toAmount(it.order_item?.unit_price),
      })),
    };
  });

  const shaped = {
    id: row.id,
    order_no: row.order_no,
    status,
    status_label: orderStatusLabel(status),
    created_at: row.created_at,
    source: row.source_channel ?? null,
    customer_name: maskName(row.recipient_name),
    item_count: items.reduce((sum, it) => sum + it.quantity, 0),
    // 实付：仅已支付订单返回真实支付金额，未支付一律 0，不伪造
    paid_amount: row.payment_status === "paid" ? toAmount(row.total_amount) : 0,
    goods_amount: toAmount(row.subtotal),
    discount_amount: toAmount(row.discount_total),
    freight_amount: toAmount(row.shipping_fee),
    items,
    fulfillments,
  };
  if (!detail) return shaped;
  return {
    ...shaped,
    recipient_name: maskName(row.recipient_name),
    recipient_phone: maskPhone(row.recipient_phone),
    address_summary: buildAddressSummary(row.shipping_address),
    customer_note: row.customer_note ?? null,
    paid_at: row.paid_at,
    delivery_method: row.fulfillment_method ?? null,
  };
}

export async function listOrders(input: {
  q: string | null;
  status: OrderStatusFilter;
  page: number;
  pageSize: number;
  locationId: string | null;
}) {
  let query = supabaseAdmin
    .from("commerce_orders" as never)
    .select(ORDER_SELECT, { count: "exact" });

  if (input.q) {
    const like = `%${input.q.replace(/[%,]/g, "")}%`;
    query = query.or(`order_no.ilike.${like},recipient_name.ilike.${like}`);
  }
  if (input.locationId) {
    const ids = await orderIdsAtLocation(input.locationId);
    if (ids.length === 0) {
      return { items: [], total: 0 };
    }
    query = query.in("id", ids);
  }

  switch (input.status) {
    case "cancelled":
      query = query.in("order_status", ["cancelled", "closed"]);
      break;
    case "after_sales":
      query = query.eq("order_status", "after_sale");
      break;
    case "completed":
      query = query.eq("order_status", "completed");
      break;
    case "unpaid":
      query = query.neq("payment_status", "paid").not("order_status", "in", "(cancelled,closed)");
      break;
    case "shipped":
    case "pending": {
      const shipped = await orderIdsWithHandedOverFulfillment();
      if (input.status === "shipped") {
        const ids = Array.from(shipped);
        if (ids.length === 0) return { items: [], total: 0 };
        query = query.in("id", ids);
      } else {
        query = query.eq("payment_status", "paid").in("order_status", ["confirmed", "processing"]);
        const ids = Array.from(shipped);
        if (ids.length > 0) query = query.not("id", "in", `(${ids.join(",")})`);
      }
      break;
    }
    default:
      break;
  }

  const from = (input.page - 1) * input.pageSize;
  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range(from, from + input.pageSize - 1);
  if (error) throw new Error(error.message);
  const rows = (data as unknown as RawOrderRow[] | null) ?? [];
  return { items: rows.map((row) => shapeOrder(row, false)), total: count ?? rows.length };
}

export async function getOrderDetail(orderId: string) {
  const { data, error } = await supabaseAdmin
    .from("commerce_orders" as never)
    .select(ORDER_SELECT)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return shapeOrder(data as unknown as RawOrderRow, true);
}

/* ------------------------- 履约分页列表 ------------------------- */

export type FulfillmentStatusFilter =
  | "all"
  | "pending_customer"
  | "allocated"
  | "picking"
  | "picked"
  | "handover_ready"
  | "handed_over"
  | "cancelled";

export const FULFILLMENT_STATUS_FILTERS: FulfillmentStatusFilter[] = [
  "all",
  "pending_customer",
  "allocated",
  "picking",
  "picked",
  "handover_ready",
  "handed_over",
  "cancelled",
];

const FULFILLMENT_LIST_SELECT =
  "id, code, order_id, location_id, status, priority, claimed_device_id, claimed_at, created_at, " +
  "location:inv_locations!location_id(name), " +
  "order:commerce_orders!order_id(order_no, courier_provider, courier_service_code, fulfillment_method, customer_note), " +
  "items:fulfillment_items(id, expected_qty, picked_qty, order_item:commerce_order_items!order_item_id(title_snapshot, unit_price, image_snapshot), sku:inv_skus!sku_id(name, barcode, image_url, sku_code))";

type RawFulfillmentRow = {
  id: string;
  code: string | null;
  order_id: string;
  location_id: string;
  status: string;
  priority: number | null;
  claimed_device_id: string | null;
  claimed_at: string | null;
  created_at: string;
  location: { name: string } | null;
  order: {
    order_no: string;
    courier_provider: string | null;
    courier_service_code: string | null;
    fulfillment_method: string | null;
    customer_note: string | null;
  } | null;
  items: Array<{
    id: string;
    expected_qty: number;
    picked_qty: number;
    order_item: {
      title_snapshot: string | null;
      unit_price: number | null;
      image_snapshot: string | null;
    } | null;
    sku: {
      name: string | null;
      barcode: string | null;
      image_url: string | null;
      sku_code: string | null;
    } | null;
  }> | null;
};

async function shortageStatusByItem(fulfillmentIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (fulfillmentIds.length === 0) return map;
  const { data } = await supabaseAdmin
    .from("fulfillment_shortages" as never)
    .select("fulfillment_item_id, status, created_at")
    .in("fulfillment_id", fulfillmentIds)
    .order("created_at", { ascending: true });
  for (const row of (data as { fulfillment_item_id: string; status: string }[] | null) ?? []) {
    map.set(row.fulfillment_item_id, row.status);
  }
  return map;
}

export async function listFulfillmentsPaged(input: {
  status: FulfillmentStatusFilter;
  q: string | null;
  page: number;
  pageSize: number;
  locationIds: string[] | null; // null = 全部（仅 HQ scope=all）
}) {
  let query = supabaseAdmin
    .from("fulfillments" as never)
    .select(FULFILLMENT_LIST_SELECT, { count: "exact" });

  if (input.locationIds) {
    if (input.locationIds.length === 0) return { items: [], total: 0 };
    query = query.in("location_id", input.locationIds);
  }

  if (input.status === "cancelled") {
    // 契约差异：fulfillments 表没有 cancelled 状态，返回空集而不是伪造数据。
    return { items: [], total: 0 };
  }
  if (input.status === "pending_customer") {
    const { data } = await supabaseAdmin
      .from("fulfillment_shortages" as never)
      .select("fulfillment_id")
      .eq("status", "pending_customer")
      .limit(10000);
    const ids = Array.from(
      new Set(((data as { fulfillment_id: string }[] | null) ?? []).map((r) => r.fulfillment_id)),
    );
    if (ids.length === 0) return { items: [], total: 0 };
    query = query.in("id", ids);
  } else if (input.status !== "all") {
    query = query.eq("status", input.status);
  }

  if (input.q) {
    const like = `%${input.q.replace(/[%,]/g, "")}%`;
    const { data } = await supabaseAdmin
      .from("commerce_orders" as never)
      .select("id")
      .ilike("order_no", like)
      .limit(10000);
    const orderIds = ((data as { id: string }[] | null) ?? []).map((r) => r.id);
    const orderClause = orderIds.length ? `,order_id.in.(${orderIds.join(",")})` : "";
    query = query.or(`code.ilike.${like}${orderClause}`);
  }

  const from = (input.page - 1) * input.pageSize;
  const { data, count, error } = await query
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .range(from, from + input.pageSize - 1);
  if (error) throw new Error(error.message);
  const rows = (data as unknown as RawFulfillmentRow[] | null) ?? [];
  const shortages = await shortageStatusByItem(rows.map((r) => r.id));

  const items = rows.map((row) => {
    const rowItems = row.items ?? [];
    return {
      // 旧字段保留
      id: row.id,
      code: row.code,
      order_id: row.order_id,
      location_id: row.location_id,
      status: row.status,
      priority: row.priority,
      claimed_device_id: row.claimed_device_id,
      claimed_at: row.claimed_at,
      created_at: row.created_at,
      order: row.order,
      // 新增字段
      location_name: row.location?.name ?? null,
      order_no: row.order?.order_no ?? null,
      status_label: FULFILLMENT_STATUS_LABELS[row.status] ?? row.status,
      item_count: rowItems.reduce((sum, it) => sum + Number(it.expected_qty ?? 0), 0),
      goods_amount: toAmount(
        rowItems.reduce(
          (sum, it) => sum + Number(it.order_item?.unit_price ?? 0) * Number(it.expected_qty ?? 0),
          0,
        ),
      ),
      delivery_method: row.order?.fulfillment_method ?? row.order?.courier_service_code ?? null,
      items: rowItems.map((it) => ({
        id: it.id,
        expected_qty: it.expected_qty,
        picked_qty: it.picked_qty,
        location_label: row.location?.name
          ? `${row.location.name}${it.sku?.sku_code ? ` · ${it.sku.sku_code}` : ""}`
          : null,
        shortage_status: shortages.get(it.id) ?? null,
        sku: {
          name: it.sku?.name ?? null,
          barcode: it.sku?.barcode ?? null,
          image_url: it.sku?.image_url ?? it.order_item?.image_snapshot ?? null,
        },
        order_item: {
          title_snapshot: it.order_item?.title_snapshot ?? null,
          unit_price: toAmount(it.order_item?.unit_price),
        },
      })),
    };
  });
  return { items, total: count ?? items.length };
}
