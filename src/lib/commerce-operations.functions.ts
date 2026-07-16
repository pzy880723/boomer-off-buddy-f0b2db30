import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type CommerceOrderAdminRow = {
  id: string;
  order_no: string;
  payment_status: string;
  order_status: string;
  total_amount: number;
  recipient_name: string;
  recipient_phone: string;
  courier_provider: string;
  courier_service_name: string | null;
  paid_at: string | null;
  created_at: string;
  items: Array<{
    id: string;
    title_snapshot: string;
    image_snapshot: string | null;
    unit_price: number;
    location_id: string;
    location: { name: string } | null;
  }>;
  fulfillments: Array<{
    id: string;
    code: string;
    status: string;
    location_id: string;
    location: { name: string } | null;
  }>;
};

export type CommerceAfterSaleAdminRow = {
  id: string;
  after_sale_no: string;
  order_id: string;
  order_item_id: string;
  location_id: string;
  type: string;
  status: string;
  reason_code: string;
  reason_text: string | null;
  requested_amount: number;
  approved_amount: number | null;
  requested_at: string;
  updated_at: string;
  order: { order_no: string; recipient_name: string; recipient_phone: string } | null;
  order_item: { title_snapshot: string; image_snapshot: string | null; unit_price: number } | null;
  location: { name: string } | null;
};

export const listCommerceOrders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        search: z.string().trim().max(100).optional(),
        limit: z.number().int().min(1).max(500).default(200),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { data: rawRows, error } = await supabaseAdmin
      .from("commerce_orders" as never)
      .select(
        "id,order_no,payment_status,order_status,total_amount,recipient_name,recipient_phone,courier_provider,courier_service_name,paid_at,created_at,items:commerce_order_items(id,title_snapshot,image_snapshot,unit_price,location_id,location:inv_locations!location_id(name)),fulfillments(id,code,status,location_id,location:inv_locations!location_id(name))",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    const needle = data.search?.toLocaleLowerCase() ?? "";
    const rows = (rawRows ?? []) as unknown as CommerceOrderAdminRow[];
    return {
      rows: rows.filter((row) => {
        if (!needle) return true;
        return [
          row.order_no,
          row.recipient_name,
          row.recipient_phone,
          ...row.items.map((item) => item.title_snapshot),
          ...row.items.map((item) => item.location?.name ?? ""),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle);
      }),
    };
  });

export const listCommerceAfterSales = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        search: z.string().trim().max(100).optional(),
        limit: z.number().int().min(1).max(500).default(200),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { data: rawRows, error } = await supabaseAdmin
      .from("commerce_after_sales" as never)
      .select(
        "id,after_sale_no,order_id,order_item_id,location_id,type,status,reason_code,reason_text,requested_amount,approved_amount,requested_at,updated_at,order:commerce_orders!order_id(order_no,recipient_name,recipient_phone),order_item:commerce_order_items!order_item_id(title_snapshot,image_snapshot,unit_price),location:inv_locations!location_id(name)",
      )
      .order("requested_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    const needle = data.search?.toLocaleLowerCase() ?? "";
    const rows = (rawRows ?? []) as unknown as CommerceAfterSaleAdminRow[];
    return {
      rows: rows.filter((row) => {
        if (!needle) return true;
        return [
          row.after_sale_no,
          row.order?.order_no,
          row.order?.recipient_name,
          row.order?.recipient_phone,
          row.order_item?.title_snapshot,
          row.location?.name,
          row.reason_code,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle);
      }),
    };
  });

export const transitionCommerceAfterSale = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        next_status: z.enum([
          "store_reviewing",
          "approved",
          "rejected",
          "customer_shipping",
          "store_received",
          "inspecting",
          "refund_pending",
          "closed",
        ]),
        store_note: z.string().trim().max(1000).optional(),
        approved_amount: z.number().positive().optional(),
        rejection_reason: z.string().trim().min(1).max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await supabaseAdmin.rpc(
      "commerce_transition_after_sale" as never,
      {
        p_after_sale_id: data.id,
        p_next_status: data.next_status,
        p_operator_id: context.userId,
        p_store_note: data.store_note ?? null,
        p_approved_amount: data.approved_amount ?? null,
        p_rejection_reason: data.rejection_reason ?? null,
      } as never,
    );
    if (error) throw new Error(error.message);
    return { row };
  });
