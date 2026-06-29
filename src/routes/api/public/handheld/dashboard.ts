import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  userCanAccessLocation,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type DashboardTask = {
  id: string;
  type: "transfer_in" | "stocktake" | "transfer_out";
  urgency: "normal" | "urgent";
  title: string;
  description: string;
  meta: string;
  action: string;
  target_id: string;
};

type DashboardItem = {
  id: string;
  name: string;
  sku_code: string | null;
  barcode: string | null;
  price: number | null;
  condition_grade: string | null;
  image_url: string | null;
  status: string | null;
};

function fmtTime(ts: string | null | undefined): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export const Route = createFileRoute("/api/public/handheld/dashboard")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        const url = new URL(request.url);
        const locationId = url.searchParams.get("location_id") || auth.device.location_id;
        if (!locationId) {
          return err("Missing location_id", 400, { code: "no_location" });
        }

        // Permission check (best-effort; only if session token supplied)
        const session = await resolveSessionUser(request);
        if (session) {
          const okPerm = await userCanAccessLocation(session.user_id, locationId);
          if (!okPerm) {
            return err("You do not have permission to operate this location", 403, {
              code: "location_forbidden",
            });
          }
        }

        // ---- 1. stats ----
        const { data: stockRows } = await supabaseAdmin
          .from("inv_stocks")
          .select("qty")
          .eq("location_id", locationId);
        const stock_count = ((stockRows as { qty: number }[] | null) ?? []).reduce(
          (s, r) => s + (Number(r.qty) || 0),
          0,
        );

        const { count: inTransitToHere } = await supabaseAdmin
          .from("stock_transfers" as never)
          .select("id", { count: "exact", head: true })
          .eq("to_location_id", locationId)
          .in("status", ["shipped", "in_transit"]);

        // ---- 2. tasks: incoming transfers awaiting receipt ----
        const { data: tferRows } = await supabaseAdmin
          .from("stock_transfers" as never)
          .select("id, code, status, qty, shipped_at")
          .eq("to_location_id", locationId)
          .in("status", ["shipped", "in_transit"])
          .order("shipped_at", { ascending: false })
          .limit(10);

        const tasks: DashboardTask[] = ((tferRows as any[] | null) ?? []).map((t) => ({
          id: t.id,
          type: "transfer_in",
          urgency: "urgent",
          title: `调拨入库 ${t.code ?? ""}`.trim(),
          description: `共 ${t.qty ?? 0} 件，待验收入库`,
          meta: fmtTime(t.shipped_at),
          action: "transfer_detail",
          target_id: t.id,
        }));

        // open stocktakes at this location
        const { data: stkRows } = await supabaseAdmin
          .from("stocktakes" as never)
          .select("id, code, status, opened_at")
          .eq("location_id", locationId)
          .eq("status", "open")
          .order("opened_at", { ascending: false })
          .limit(5);
        for (const s of (stkRows as any[] | null) ?? []) {
          tasks.push({
            id: s.id,
            type: "stocktake",
            urgency: "normal",
            title: `盘点 ${s.code ?? ""}`.trim(),
            description: "盘点进行中，待提交",
            meta: fmtTime(s.opened_at),
            action: "stocktake_detail",
            target_id: s.id,
          });
        }

        // ---- 3. recent items: most recent SKUs (warehouse only carries stock_qty;
        // for shops we approximate via inv_stocks at this location)
        let recent_items: DashboardItem[] = [];
        if (auth.device.location_kind === "warehouse") {
          const { data: skuRows } = await supabaseAdmin
            .from("inv_skus")
            .select(
              "id, name, sku_code, barcode, price_tier, grade, image_url, status, updated_at",
            )
            .order("updated_at", { ascending: false })
            .limit(6);
          recent_items = ((skuRows as any[] | null) ?? []).map((r) => ({
            id: r.id,
            name: r.name,
            sku_code: r.sku_code ?? null,
            barcode: r.barcode ?? null,
            price: typeof r.price_tier === "number" ? r.price_tier : null,
            condition_grade: r.grade ?? null,
            image_url: r.image_url ?? null,
            status: r.status ?? null,
          }));
        } else {
          const { data: stRows } = await supabaseAdmin
            .from("inv_stocks")
            .select("sku_id, updated_at, qty, sku:inv_skus!sku_id(id, name, sku_code, barcode, price_tier, grade, image_url, status)" as never)
            .eq("location_id", locationId)
            .gt("qty", 0)
            .order("updated_at", { ascending: false })
            .limit(6);
          recent_items = ((stRows as any[] | null) ?? [])
            .filter((r) => r.sku)
            .map((r) => ({
              id: r.sku.id,
              name: r.sku.name,
              sku_code: r.sku.sku_code ?? null,
              barcode: r.sku.barcode ?? null,
              price: typeof r.sku.price_tier === "number" ? r.sku.price_tier : null,
              condition_grade: r.sku.grade ?? null,
              image_url: r.sku.image_url ?? null,
              status: r.sku.status ?? null,
            }));
        }

        // ---- 4. unread notifications for this device ----
        const { count: unreadCount } = await supabaseAdmin
          .from("inv_handheld_notifications" as never)
          .select("id", { count: "exact", head: true })
          .eq("device_id", auth.device.id);

        return ok({
          stats: {
            stock_count,
            inventory_accuracy: null,
            in_transit_count: inTransitToHere ?? 0,
          },
          tasks,
          recent_items,
          unread_notifications: unreadCount ?? 0,
        });
      },
    },
  },
});
