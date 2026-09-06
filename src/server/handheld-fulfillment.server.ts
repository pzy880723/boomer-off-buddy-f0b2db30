// 履约共享逻辑：员工 session 权限、订单码解析、拣货小票、缺货申报。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { userCanAccessLocation, err, type DeviceContext } from "@/server/handheld-auth.server";

export const FULFILLMENT_QR_PREFIX = "boomer-erp:fulfillment:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 设备 + 员工双重校验：员工必须对设备当前库位有权限。 */
export async function requireStaffAtDeviceLocation(
  device: DeviceContext,
  session: { user_id: string } | null,
): Promise<{ ok: true; userId: string; locationId: string } | { ok: false; response: Response }> {
  if (!device.location_id) {
    return { ok: false, response: err("Device has no bound location", 400, { code: "no_location" }) };
  }
  if (!session) {
    return { ok: false, response: err("Employee session required", 401, { code: "session_required" }) };
  }
  const allowed = await userCanAccessLocation(session.user_id, device.location_id);
  if (!allowed) {
    return {
      ok: false,
      response: err("You do not have permission to operate this location", 403, {
        code: "location_forbidden",
      }),
    };
  }
  return { ok: true, userId: session.user_id, locationId: device.location_id };
}

/**
 * 只接受固定命名空间 boomer-erp:fulfillment:<UUID> 或真实履约单号 code。
 * 任意 URL / 其它前缀一律拒绝，避免扫码被引导到外部地址。
 */
export function parseFulfillmentCode(
  raw: string,
): { kind: "id"; value: string } | { kind: "code"; value: string } | null {
  const code = raw.trim();
  if (!code || code.length > 200) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(code)) return null;
  if (code.startsWith(FULFILLMENT_QR_PREFIX)) {
    const id = code.slice(FULFILLMENT_QR_PREFIX.length).trim();
    return UUID_RE.test(id) ? { kind: "id", value: id } : null;
  }
  if (/^[A-Za-z0-9_-]{4,64}$/.test(code)) return { kind: "code", value: code };
  return null;
}

export async function resolveFulfillmentByCode(input: {
  raw: string;
  locationId: string;
}): Promise<{ id: string; code: string | null; status: string } | null> {
  const parsed = parseFulfillmentCode(input.raw);
  if (!parsed) return null;
  let query = supabaseAdmin
    .from("fulfillments" as never)
    .select("id, code, status, location_id")
    .eq("location_id", input.locationId)
    .limit(1);
  query = parsed.kind === "id" ? query.eq("id", parsed.value) : query.eq("code", parsed.value);
  const { data } = await query.maybeSingle();
  return (data as unknown as { id: string; code: string | null; status: string }) ?? null;
}

export type FulfillmentTicket = {
  title: string;
  fulfillment_id: string;
  order_no: string;
  qr_content: string;
  location_name: string | null;
  lines: Array<{
    id: string;
    title: string;
    barcode: string | null;
    quantity: number;
    unit_price: number | null;
    location: string | null;
  }>;
  customer_note: string | null;
  paid_at: string | null;
};

export async function buildFulfillmentTicket(input: {
  fulfillmentId: string;
  locationId: string;
}): Promise<
  { ok: true; ticket: FulfillmentTicket } | { ok: false; code: "not_found" | "order_unpaid" }
> {
  const { data } = await supabaseAdmin
    .from("fulfillments" as never)
    .select(
      "id, code, location_id, order:commerce_orders!order_id(order_no, payment_status, paid_at, customer_note), location:inv_locations!location_id(name), items:fulfillment_items(id, expected_qty, order_item:commerce_order_items!order_item_id(title_snapshot, unit_price), sku:inv_skus!sku_id(name, barcode, sku_code))",
    )
    .eq("id", input.fulfillmentId)
    .eq("location_id", input.locationId)
    .maybeSingle();
  if (!data) return { ok: false, code: "not_found" };
  const row = data as unknown as {
    id: string;
    code: string | null;
    location_id: string;
    order: {
      order_no: string;
      payment_status: string;
      paid_at: string | null;
      customer_note: string | null;
    } | null;
    location: { name: string } | null;
    items: Array<{
      id: string;
      expected_qty: number;
      order_item: { title_snapshot: string | null; unit_price: number | null } | null;
      sku: { name: string | null; barcode: string | null; sku_code: string | null } | null;
    }> | null;
  };
  if (!row.order || row.order.payment_status !== "paid") return { ok: false, code: "order_unpaid" };

  // 库位标签：门店/仓库名 + SKU 码，便于拣货定位
  const locationName = row.location?.name ?? null;
  return {
    ok: true,
    ticket: {
      title: `拣货单 ${row.code ?? row.order.order_no}`,
      fulfillment_id: row.id,
      order_no: row.order.order_no,
      qr_content: `${FULFILLMENT_QR_PREFIX}${row.id}`,
      location_name: locationName,
      lines: (row.items ?? []).map((item) => ({
        id: item.id,
        title: item.order_item?.title_snapshot ?? item.sku?.name ?? "商品",
        barcode: item.sku?.barcode ?? item.sku?.sku_code ?? null,
        quantity: item.expected_qty,
        unit_price: item.order_item?.unit_price ?? null,
        location: locationName ? `${locationName}${item.sku?.sku_code ? ` · ${item.sku.sku_code}` : ""}` : null,
      })),
      customer_note: row.order.customer_note ?? null,
      paid_at: row.order.paid_at ?? null,
    },
  };
}
