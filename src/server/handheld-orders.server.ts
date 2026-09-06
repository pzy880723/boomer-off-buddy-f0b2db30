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

/**
 * 只有「全部有效子单都已交接」才算 shipped；部分交接仍属待履约（标签「部分履约」），
 * 否则会漏备货。退款/售后优先于完成态。
 * 与数据库函数 handheld_search_order_ids 内的 CASE 保持同一套规则。
 */
export function deriveOrderStatus(input: {
  payment_status: string | null;
  order_status: string | null;
  fulfillment_count: number;
  handed_over_count: number;
  has_active_after_sale?: boolean;
}): DerivedOrderStatus {
  const order = input.order_status ?? "";
  const payment = input.payment_status ?? "";
  if (order === "cancelled" || order === "closed") return "cancelled";
  if (
    order === "after_sale" ||
    input.has_active_after_sale === true ||
    ["refunding", "refunded", "partial_refunded"].includes(payment)
  ) {
    return "after_sales";
  }
  if (order === "completed") return "completed";
  if (payment !== "paid") return "unpaid";
  if (input.fulfillment_count > 0 && input.handed_over_count === input.fulfillment_count) {
    return "shipped";
  }
  return "pending";
}

/** 部分交接时展示「部分履约」，筛选仍归入 pending，保证不漏备货。 */
export function orderStatusLabelFor(
  status: DerivedOrderStatus,
  counts: { fulfillment_count: number; handed_over_count: number },
): string {
  if (status === "pending" && counts.handed_over_count > 0) return "部分履约";
  return ORDER_STATUS_LABELS[status];
}

export function orderStatusLabel(status: DerivedOrderStatus): string {
  return ORDER_STATUS_LABELS[status];
}

export async function isHqUser(userId: string): Promise<boolean> {
  const roles = await loadUserRoles(userId);
  return roles.includes("super_admin") || roles.includes("hq_operator");
}

/** 图片：优先当前 image_paths 的新签名 URL；快照签名可能已过期时回退到当前图。 */
export function pickImageUrl(input: {
  signed?: string | null;
  snapshot?: string | null;
  legacy?: string | null;
}): string | null {
  if (input.signed) return input.signed;
  const snap = input.snapshot ?? "";
  if (snap && !/token=/i.test(snap)) return snap;
  const legacy = input.legacy ?? "";
  if (legacy && /^https?:\/\//i.test(legacy) && !/token=/i.test(legacy)) return legacy;
  return null;
}

const ORDER_SELECT =
  "id, order_no, payment_status, order_status, created_at, source_channel, subtotal, shipping_fee, discount_total, total_amount, recipient_name, recipient_phone, shipping_address, customer_note, paid_at, fulfillment_method, " +
  "items:commerce_order_items(id, title_snapshot, image_snapshot, unit_price, quantity, line_total, sku:inv_skus!sku_id(barcode, image_url, image_paths)), " +
  "fulfillments:fulfillments(id, code, location_id, status, created_at, location:inv_locations!location_id(name), items:fulfillment_items(id, expected_qty, picked_qty, order_item:commerce_order_items!order_item_id(id, title_snapshot, image_snapshot, unit_price, quantity), sku:inv_skus!sku_id(name, barcode, image_url, image_paths)))";

/** 批量签名 sku 图片路径 */
async function signPaths(paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const { signSkuImagePaths } = await import("@/lib/sku-image-resolver.server");
  const signed = await signSkuImagePaths(unique);
  unique.forEach((path, index) => {
    const url = signed[index];
    if (url) map.set(path, url);
  });
  return map;
}


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
    sku: {
      barcode: string | null;
      image_url: string | null;
      image_paths: string[] | null;
    } | null;

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
      sku: {
        name: string | null;
        barcode: string | null;
        image_url: string | null;
        image_paths: string[] | null;
      } | null;
    }> | null;
  }> | null;
};

function collectOrderImagePaths(rows: RawOrderRow[]): string[] {
  const paths: string[] = [];
  for (const row of rows) {
    for (const item of row.items ?? []) paths.push(...(item.sku?.image_paths ?? []));
    for (const f of row.fulfillments ?? []) {
      for (const it of f.items ?? []) paths.push(...(it.sku?.image_paths ?? []));
    }
  }
  return paths;
}

function firstSigned(paths: string[] | null | undefined, signed: Map<string, string>) {
  for (const path of paths ?? []) {
    const url = signed.get(path);
    if (url) return url;
  }
  return null;
}

export const ORDER_WORKFLOW_VERSION = "fulfillment-2026-09";

function shapeOrder(
  row: RawOrderRow,
  detail: boolean,
  ctx: {
    signed: Map<string, string>;
    derived?: { derived_status: DerivedOrderStatus; fulfillment_count: number; handed_over_count: number };
    canWrite?: boolean;
  },
) {
  const signed = ctx.signed;
  const items = (row.items ?? []).map((item) => ({
    id: item.id,
    title: item.title_snapshot ?? "商品",
    barcode: item.sku?.barcode ?? null,
    image_url: pickImageUrl({
      signed: firstSigned(item.sku?.image_paths, signed),
      snapshot: item.image_snapshot,
      legacy: item.sku?.image_url,
    }),
    quantity: item.quantity ?? 0,
    unit_price: toAmount(item.unit_price),
  }));
  const rowFulfillments = row.fulfillments ?? [];
  const counts = ctx.derived ?? {
    derived_status: null as unknown as DerivedOrderStatus,
    fulfillment_count: rowFulfillments.length,
    handed_over_count: rowFulfillments.filter((f) => f.status === "handed_over").length,
  };
  const status =
    ctx.derived?.derived_status ??
    deriveOrderStatus({
      payment_status: row.payment_status,
      order_status: row.order_status,
      fulfillment_count: counts.fulfillment_count,
      handed_over_count: counts.handed_over_count,
    });
  const orderCancelled = status === "cancelled";
  const fulfillments = rowFulfillments.map((f) => {
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
      status_label: orderCancelled
        ? "订单已取消"
        : (FULFILLMENT_STATUS_LABELS[f.status] ?? f.status),
      order_cancelled: orderCancelled,
      actionable: !orderCancelled,
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
        image_url: pickImageUrl({
          signed: firstSigned(it.sku?.image_paths, signed),
          snapshot: it.order_item?.image_snapshot,
          legacy: it.sku?.image_url,
        }),
        unit_price: toAmount(it.order_item?.unit_price),
      })),
    };
  });

  const shaped = {
    id: row.id,
    order_no: row.order_no,
    status,
    status_label: orderStatusLabelFor(status, counts),
    fulfillment_count: counts.fulfillment_count,
    handed_over_count: counts.handed_over_count,
    partially_handed_over: status === "pending" && counts.handed_over_count > 0,
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
    workflow_version: ORDER_WORKFLOW_VERSION,
    capabilities: {
      // HQ 拥有跨店写授权；门店员工只读父订单，写操作仍走履约接口的库位校验。
      can_write: ctx.canWrite === true && !orderCancelled,
      can_operate_fulfillment: !orderCancelled,
      supports_fulfillment_cancel: false,
    },
    recipient_name: maskName(row.recipient_name),
    recipient_phone: maskPhone(row.recipient_phone),
    address_summary: buildAddressSummary(row.shipping_address),
    customer_note: row.customer_note ?? null,
    paid_at: row.paid_at,
    delivery_method: row.fulfillment_method ?? null,
  };
}

type OrderSearchRow = {
  order_id: string;
  derived_status: DerivedOrderStatus;
  fulfillment_count: number;
  handed_over_count: number;
  total_count: number;
};

export async function listOrders(input: {
  q: string | null;
  status: OrderStatusFilter;
  page: number;
  pageSize: number;
  locationId: string | null;
}) {
  // 筛选/计数/分页全部在数据库内完成（handheld_search_order_ids），
  // 避免有限 ID 列表 + 大 in 造成的假 total。
  const { data: searchData, error: searchError } = await supabaseAdmin.rpc(
    "handheld_search_order_ids" as never,
    {
      p_q: input.q,
      p_status: input.status,
      p_location_id: input.locationId,
      p_limit: input.pageSize,
      p_offset: (input.page - 1) * input.pageSize,
    } as never,
  );
  if (searchError) throw new Error(searchError.message);
  const search = (searchData as unknown as OrderSearchRow[] | null) ?? [];
  const total = search.length ? Number(search[0].total_count) : 0;
  if (search.length === 0) return { items: [], total };

  const ids = search.map((r) => r.order_id);
  const { data, error } = await supabaseAdmin
    .from("commerce_orders" as never)
    .select(ORDER_SELECT)
    .in("id", ids);
  if (error) throw new Error(error.message);
  const rows = (data as unknown as RawOrderRow[] | null) ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const signed = await signPaths(collectOrderImagePaths(rows));
  const items = search.flatMap((meta) => {
    const row = byId.get(meta.order_id);
    if (!row) return [];
    return [
      shapeOrder(row, false, {
        signed,
        derived: {
          derived_status: meta.derived_status,
          fulfillment_count: Number(meta.fulfillment_count ?? 0),
          handed_over_count: Number(meta.handed_over_count ?? 0),
        },
      }),
    ];
  });
  return { items, total };
}

export async function getOrderDetail(orderId: string, options?: { canWrite?: boolean }) {
  const { data, error } = await supabaseAdmin
    .from("commerce_orders" as never)
    .select(ORDER_SELECT)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as unknown as RawOrderRow;
  const signed = await signPaths(collectOrderImagePaths([row]));
  const { data: afterSales } = await supabaseAdmin
    .from("commerce_after_sales" as never)
    .select("id, status")
    .eq("order_id", orderId)
    .limit(50);
  const hasActiveAfterSale = ((afterSales as { status: string }[] | null) ?? []).some(
    (r) => !["rejected", "closed", "cancelled"].includes(r.status),
  );
  const fulfillments = row.fulfillments ?? [];
  const derivedStatus = deriveOrderStatus({
    payment_status: row.payment_status,
    order_status: row.order_status,
    fulfillment_count: fulfillments.length,
    handed_over_count: fulfillments.filter((f) => f.status === "handed_over").length,
    has_active_after_sale: hasActiveAfterSale,
  });
  return shapeOrder(row, true, {
    signed,
    derived: {
      derived_status: derivedStatus,
      fulfillment_count: fulfillments.length,
      handed_over_count: fulfillments.filter((f) => f.status === "handed_over").length,
    },
    canWrite: options?.canWrite,
  });
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
  "order:commerce_orders!order_id(order_no, order_status, courier_provider, courier_service_code, fulfillment_method, customer_note), " +
  "items:fulfillment_items(id, expected_qty, picked_qty, order_item:commerce_order_items!order_item_id(title_snapshot, unit_price, image_snapshot), sku:inv_skus!sku_id(name, barcode, image_url, image_paths, sku_code))";


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

type FulfillmentSearchRow = {
  fulfillment_id: string;
  order_cancelled: boolean;
  has_pending_customer: boolean;
  total_count: number;
};

export async function listFulfillmentsPaged(input: {
  status: FulfillmentStatusFilter;
  q: string | null;
  page: number;
  pageSize: number;
  locationIds: string[] | null; // null = 全部（仅 HQ scope=all）
}) {
  if (input.locationIds && input.locationIds.length === 0) return { items: [], total: 0 };

  // 数据库内筛选 + 计数 + 分页，避免预拉 ID 列表被截断导致 total 虚假。
  const { data: searchData, error: searchError } = await supabaseAdmin.rpc(
    "handheld_search_fulfillment_ids" as never,
    {
      p_q: input.q,
      p_status: input.status,
      p_location_ids: input.locationIds,
      p_limit: input.pageSize,
      p_offset: (input.page - 1) * input.pageSize,
    } as never,
  );
  if (searchError) throw new Error(searchError.message);
  const search = (searchData as unknown as FulfillmentSearchRow[] | null) ?? [];
  const total = search.length ? Number(search[0].total_count) : 0;
  if (search.length === 0) return { items: [], total };

  const ids = search.map((r) => r.fulfillment_id);
  const { data, error } = await supabaseAdmin
    .from("fulfillments" as never)
    .select(FULFILLMENT_LIST_SELECT)
    .in("id", ids);
  if (error) throw new Error(error.message);
  const rows = (data as unknown as RawFulfillmentRow[] | null) ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const shortages = await shortageStatusByItem(ids);
  const signed = await signPaths(
    rows.flatMap((row) => (row.items ?? []).flatMap((it) => it.sku?.image_paths ?? [])),
  );

  const items = search.flatMap((meta) => {
    const row = byId.get(meta.fulfillment_id);
    if (!row) return [];
    const rowItems = row.items ?? [];
    const orderCancelled =
      meta.order_cancelled === true ||
      ["cancelled", "closed"].includes(row.order?.order_status ?? "");
    return [
      {
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
        status_label: orderCancelled
          ? "订单已取消"
          : (FULFILLMENT_STATUS_LABELS[row.status] ?? row.status),
        // 履约表本身没有 cancelled 状态：由父订单取消推导，并禁止一切操作。
        order_cancelled: orderCancelled,
        actionable: !orderCancelled,
        has_pending_customer: meta.has_pending_customer === true,
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
          // 地点 ≠ 架位：库位表当前没有货架/储位字段，缺架位时为 null，绝不用 SKU 码冒充货架。
          location_label: null,
          shortage_status: shortages.get(it.id) ?? null,
          sku: {
            name: it.sku?.name ?? null,
            barcode: it.sku?.barcode ?? null,
            sku_code: it.sku?.sku_code ?? null,
            image_url: pickImageUrl({
              signed: firstSigned(it.sku?.image_paths, signed),
              snapshot: it.order_item?.image_snapshot,
              legacy: it.sku?.image_url,
            }),
          },
          order_item: {
            title_snapshot: it.order_item?.title_snapshot ?? null,
            unit_price: toAmount(it.order_item?.unit_price),
          },
        })),
      },
    ];
  });
  return { items, total };
}

