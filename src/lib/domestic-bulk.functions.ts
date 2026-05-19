import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

export const BULK_STATUSES = ["pending_pay", "paid", "shipped", "delivered", "completed"] as const;
export type BulkStatus = (typeof BULK_STATUSES)[number];

export const BULK_STATUS_LABEL: Record<BulkStatus, string> = {
  pending_pay: "待付款",
  paid: "已付款",
  shipped: "已发货",
  delivered: "已签收",
  completed: "已完成",
};

const LineInput = z.object({
  position: z.number().int().nonnegative().default(0),
  item_title: z.string().nullable().optional(),
  qty: z.number().int().min(1).default(1),
  unit_price_cny: z.number().nullable().optional(),
  subtotal_cny: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const OrderInput = z.object({
  supplier_name: z.string().nullable().optional(),
  supplier_contact: z.string().nullable().optional(),
  source_order_no: z.string().nullable().optional(),
  purchased_at: z.string().nullable().optional(),
  total_cny: z.number().nullable().optional(),
  shipping_cny: z.number().nullable().optional(),
  status: z.enum(BULK_STATUSES).default("paid"),
  carrier: z.string().nullable().optional(),
  tracking_no: z.string().nullable().optional(),
  receiver_name: z.string().nullable().optional(),
  receiver_phone: z.string().nullable().optional(),
  receiver_address: z.string().nullable().optional(),
  delivered_at: z.string().nullable().optional(),
  invoice_no: z.string().nullable().optional(),
  contract_no: z.string().nullable().optional(),
  pay_method: z.string().nullable().optional(),
  attachment_urls: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
});

export type DomesticBulkOrderInput = z.infer<typeof OrderInput>;
export type DomesticBulkLineInput = z.infer<typeof LineInput>;

function completeness(o: Partial<DomesticBulkOrderInput>, lineCount: number): number {
  const fields = [
    "supplier_name",
    "source_order_no",
    "purchased_at",
    "total_cny",
    "tracking_no",
    "invoice_no",
    "contract_no",
  ];
  const filled = fields.filter((k) => {
    const v = (o as Record<string, unknown>)[k];
    return v != null && v !== "";
  }).length;
  const base = Math.round((filled / fields.length) * 80);
  return Math.min(100, base + (lineCount > 0 ? 20 : 0));
}

export const listDomesticBulkOrders = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z.enum(BULK_STATUSES).optional(),
        search: z.string().optional(),
        limit: z.number().min(1).max(500).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    let q = supabase
      .from("domestic_bulk_orders")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status) q = q.eq("status", data.status);
    if (data.search) {
      const s = `%${data.search}%`;
      q = q.or(
        `source_order_no.ilike.${s},supplier_name.ilike.${s},tracking_no.ilike.${s},contract_no.ilike.${s},invoice_no.ilike.${s}`,
      );
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const countDomesticBulkOrders = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await supabase
    .from("domestic_bulk_orders")
    .select("status,total_cny")
    .is("deleted_at", null);
  if (error) throw new Error(error.message);
  const byStatus: Record<string, number> = {};
  let totalCny = 0;
  for (const r of data ?? []) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    totalCny += Number(r.total_cny ?? 0);
  }
  return { byStatus, total: data?.length ?? 0, totalCny };
});

export const getDomesticBulkOrder = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: order, error } = await supabase
      .from("domestic_bulk_orders")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    const { data: lines, error: lErr } = await supabase
      .from("domestic_bulk_order_lines")
      .select("*")
      .eq("order_id", data.id)
      .order("position", { ascending: true });
    if (lErr) throw new Error(lErr.message);
    return { order, lines: lines ?? [] };
  });

export const createDomesticBulkOrder = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        order: OrderInput,
        lines: z.array(LineInput).default([]),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const payload = {
      ...data.order,
      attachment_urls: data.order.attachment_urls ?? [],
      completeness: completeness(data.order, data.lines.length),
    };
    const { data: row, error } = await supabase
      .from("domestic_bulk_orders")
      .insert(payload as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    if (data.lines.length > 0) {
      const linePayload = data.lines.map((l, i) => ({ ...l, position: i, order_id: row.id }));
      const { error: lErr } = await supabase
        .from("domestic_bulk_order_lines")
        .insert(linePayload as never);
      if (lErr) throw new Error(lErr.message);
    }
    return { id: row.id };
  });

export const updateDomesticBulkOrder = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        patch: OrderInput.partial(),
        lines: z.array(LineInput).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const patch = { ...data.patch } as Record<string, unknown>;
    const { data: current } = await supabase
      .from("domestic_bulk_orders")
      .select("*")
      .eq("id", data.id)
      .single();
    const lineCount =
      data.lines?.length ??
      (await supabase
        .from("domestic_bulk_order_lines")
        .select("id", { count: "exact", head: true })
        .eq("order_id", data.id)).count ??
      0;
    if (current) {
      patch.completeness = completeness({ ...current, ...patch } as Partial<DomesticBulkOrderInput>, lineCount);
    }
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase
        .from("domestic_bulk_orders")
        .update(patch as never)
        .eq("id", data.id);
      if (error) throw new Error(error.message);
    }
    if (data.lines) {
      const { error: dErr } = await supabase
        .from("domestic_bulk_order_lines")
        .delete()
        .eq("order_id", data.id);
      if (dErr) throw new Error(dErr.message);
      if (data.lines.length > 0) {
        const linePayload = data.lines.map((l, i) => ({ ...l, position: i, order_id: data.id }));
        const { error: iErr } = await supabase
          .from("domestic_bulk_order_lines")
          .insert(linePayload as never);
        if (iErr) throw new Error(iErr.message);
      }
    }
    return { ok: true };
  });

export const setDomesticBulkOrderStatus = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), status: z.enum(BULK_STATUSES) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("domestic_bulk_orders")
      .update({ status: data.status })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const removeDomesticBulkOrder = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { error } = await supabase
      .from("domestic_bulk_orders")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
