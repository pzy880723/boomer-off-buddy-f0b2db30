/**
 * GET /api/public/handheld/parcels
 * 日本小包列表（只读，super_admin 独占）。
 * Query: bucket=pending|received, q, limit(<=50), offset
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  loadUserRoles,
  ok,
} from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { ParcelListQuery } from "@/lib/handheld/schemas";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const PENDING = ["purchased", "at_jp_warehouse", "shipping_intl"] as const;
const RECEIVED = ["delivered", "completed"] as const;

async function requireSuperAdmin(request: Request) {
  const auth = await authenticateDevice(request);
  if (!auth.ok) return { ok: false as const, response: auth.response };
  const user = await resolveSessionUser(request);
  if (!user) return { ok: false as const, response: errCode("unauthorized", "Missing session token") };
  const roles = await loadUserRoles(user.user_id);
  if (!roles.includes("super_admin")) {
    return { ok: false as const, response: errCode("unauthorized_role", "super_admin required") };
  }
  return { ok: true as const, user };
}

export { requireSuperAdmin };

export const Route = createFileRoute("/api/public/handheld/parcels")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const g = await requireSuperAdmin(request);
        if (!g.ok) return g.response;

        const url = new URL(request.url);
        const parsed = ParcelListQuery.safeParse({
          bucket: url.searchParams.get("bucket") ?? undefined,
          q: url.searchParams.get("q") ?? undefined,
          limit: url.searchParams.get("limit") ?? undefined,
          offset: url.searchParams.get("offset") ?? undefined,
        });
        if (!parsed.success) {
          return errCode("validation_error", parsed.error.message, {
            issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
        }
        const { bucket, q, limit, offset } = parsed.data;
        const from = offset;
        const to = offset + limit - 1;

        let query = supabaseAdmin
          .from("japan_parcels")
          .select(
            "id, system_code, source_order_no, tracking_no, status, item_title, item_title_cn, item_image_url, intl_pay_at, received_at, grand_total_cny, is_problem, created_at, japan_parcel_items(item_title, item_title_cn, item_image_url, item_total_cny, quantity, position)",
          )
          .is("deleted_at", null)
          .order("intl_pay_at", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false, nullsFirst: false })
          .range(from, to);

        if (bucket === "pending") query = query.in("status", PENDING as unknown as string[]);
        else query = query.in("status", RECEIVED as unknown as string[]);

        if (q) {
          const s = `%${q}%`;
          query = query.or(
            `item_title.ilike.${s},item_title_cn.ilike.${s},source_order_no.ilike.${s},tracking_no.ilike.${s},system_code.ilike.${s}`,
          );
        }

        const { data: rows, error } = await query;
        if (error) return errCode("internal_error", error.message);

        const mapped = (rows ?? []).map((r) => {
          const children = (((r as { japan_parcel_items?: Array<{ item_title: string | null; item_title_cn: string | null; item_image_url: string | null; item_total_cny: number | null; quantity: number | null; position: number | null }> }).japan_parcel_items) ?? [])
            .slice()
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
          const first = children[0];
          const first_item_name = first
            ? first.item_title_cn || first.item_title || null
            : r.item_title_cn || r.item_title || null;
          const firstImage =
            r.item_image_url ||
            children.find((c) => c.item_image_url)?.item_image_url ||
            null;
          const itemsTotalCny = children.reduce((s, c) => s + (Number(c.item_total_cny) || 0), 0);
          const totalQty = children.reduce((s, c) => s + (Number(c.quantity) || 0), 0);
          const baseTotal =
            r.grand_total_cny != null
              ? Number(r.grand_total_cny)
              : itemsTotalCny > 0
                ? itemsTotalCny
                : null;
          const avg = baseTotal != null && totalQty > 0 ? Math.round((baseTotal / totalQty) * 100) / 100 : null;
          return {
            id: r.id,
            system_code: r.system_code ?? null,
            source_order_no: r.source_order_no ?? null,
            tracking_no: r.tracking_no ?? null,
            status: r.status,
            is_problem: !!r.is_problem,
            intl_pay_at: r.intl_pay_at ?? null,
            received_at: r.received_at ?? null,
            created_at: r.created_at,
            first_item_name,
            item_image_url: firstImage,
            item_count: children.length,
            total_qty: totalQty,
            total_cny: baseTotal != null ? Math.round(baseTotal * 100) / 100 : null,
            avg_unit_cny: avg,
          };
        });

        return ok({
          rows: mapped,
          has_more: mapped.length === limit,
          next_offset: offset + mapped.length,
        });
      },
    },
  },
});
