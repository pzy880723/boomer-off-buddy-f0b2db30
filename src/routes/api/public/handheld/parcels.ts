/**
 * GET /api/public/handheld/parcels
 * 日本小包列表（只读，super_admin 独占）。
 *
 * 完整对齐 web `/m/parcels`：
 * - bucket=pending|received
 * - mode=item|parcel（默认 item，搜索时前端强制传 item）
 * - q 命中 品名 / 中文名 / 子单号（item 模式） 或 品名 / 中文名 / 来源单号 / 追踪号 / 系统编码（parcel 模式）
 *
 * 响应统一形如 { mode, items[], rows[], has_more, next_offset }，另一边为空数组。
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
import { computeParcelItemLanded, computePiecePrice } from "@/lib/japan-parcel.helpers";

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

const round2 = (v: number | null | undefined) =>
  v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100;

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
          mode: url.searchParams.get("mode") ?? undefined,
          q: url.searchParams.get("q") ?? undefined,
          limit: url.searchParams.get("limit") ?? undefined,
          offset: url.searchParams.get("offset") ?? undefined,
        });
        if (!parsed.success) {
          return errCode("validation_error", parsed.error.message, {
            issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
        }
        const { bucket, mode, q, limit, offset } = parsed.data;
        const from = offset;
        const to = offset + limit - 1;
        const statuses = bucket === "pending" ? (PENDING as unknown as string[]) : (RECEIVED as unknown as string[]);

        // ---------- item 模式 ----------
        if (mode === "item") {
          let query = supabaseAdmin
            .from("japan_parcel_items")
            .select(
              "id, parent_id, sub_order_no, merchant_order_no, source_platform, condition, addon_service, item_title, item_title_cn, item_image_url, unit_price_jpy, quantity, item_total_jpy, item_total_cny, weight_g, exchange_rate, service_fee_jpy, domestic_freight_jpy, freight_diff_jpy, pay_method, pay_at, tariff_category, tariff_rate, notes, arrival_photo_urls, position, system_code, created_by, created_at, pack_pieces, pack_pieces_source, pack_unit_note, japan_parcels!inner(id, source_order_no, tracking_no, status, received_at, is_problem, deleted_at, intl_pay_at, created_at, system_code, created_by)",
            )
            .is("japan_parcels.deleted_at", null)
            .in("japan_parcels.status", statuses)
            .range(from, to)
            .order("pay_at", { ascending: false, nullsFirst: false })
            .order("created_at", { referencedTable: "japan_parcels", ascending: false, nullsFirst: false })
            .order("position", { ascending: true });
          if (q) {
            const s = `%${q}%`;
            query = query.or(
              `item_title.ilike.${s},item_title_cn.ilike.${s},sub_order_no.ilike.${s},system_code.ilike.${s}`,
            );
          }
          const { data: rows, error } = await query;
          if (error) return errCode("internal_error", error.message);

          const items = (rows ?? []).map((r) => {
            const p = (r as { japan_parcels?: { id: string; source_order_no: string | null; tracking_no: string | null; status: string; received_at: string | null; is_problem: boolean; intl_pay_at: string | null; created_at: string; system_code: string | null; created_by: string | null } }).japan_parcels;
            return {
              id: r.id,
              parent_id: r.parent_id,
              sub_order_no: r.sub_order_no ?? null,
              merchant_order_no: r.merchant_order_no ?? null,
              source_platform: r.source_platform ?? null,
              condition: r.condition ?? null,
              addon_service: r.addon_service ?? null,
              item_title: r.item_title ?? null,
              item_title_cn: r.item_title_cn ?? null,
              item_image_url: r.item_image_url ?? null,
              unit_price_jpy: r.unit_price_jpy ?? null,
              quantity: r.quantity ?? null,
              item_total_jpy: r.item_total_jpy ?? null,
              item_total_cny: r.item_total_cny ?? null,
              weight_g: r.weight_g ?? null,
              exchange_rate: r.exchange_rate ?? null,
              service_fee_jpy: r.service_fee_jpy ?? null,
              domestic_freight_jpy: r.domestic_freight_jpy ?? null,
              freight_diff_jpy: r.freight_diff_jpy ?? null,
              pay_method: r.pay_method ?? null,
              pay_at: r.pay_at ?? null,
              tariff_category: r.tariff_category ?? null,
              tariff_rate: r.tariff_rate ?? null,
              notes: r.notes ?? null,
              arrival_photo_urls: Array.isArray(r.arrival_photo_urls) ? r.arrival_photo_urls : [],
              pack_pieces: r.pack_pieces ?? null,
              pack_pieces_source: r.pack_pieces_source ?? null,
              pack_unit_note: r.pack_unit_note ?? null,
              system_code: r.system_code ?? null,
              created_by: r.created_by ?? null,
              created_at: r.created_at,
              source_order_no: p?.source_order_no ?? null,
              tracking_no: p?.tracking_no ?? null,
              status: p?.status ?? null,
              received_at: p?.received_at ?? null,
              is_problem: p?.is_problem ?? false,
              intl_pay_at: p?.intl_pay_at ?? null,
              parcel_system_code: p?.system_code ?? null,
              parcel_created_by: p?.created_by ?? null,
              landed_cny: null as number | null,
              piece_price_cny: null as number | null,
              piece_price_jpy: null as number | null,
            };
          });

          // 附加 landed_cny + 拆件价格
          const parentIds = Array.from(new Set(items.map((i) => i.parent_id).filter(Boolean) as string[]));
          if (parentIds.length > 0) {
            const [parcelsRes, siblingsRes] = await Promise.all([
              supabaseAdmin
                .from("japan_parcels")
                .select("id, intl_total_jpy, intl_exchange_rate")
                .in("id", parentIds),
              supabaseAdmin
                .from("japan_parcel_items")
                .select("id, parent_id, item_total_jpy, unit_price_jpy, quantity, weight_g, tariff_rate")
                .in("parent_id", parentIds),
            ]);
            const parcelMap = new Map<string, { intl_total_jpy: number | null; intl_exchange_rate: number | null }>();
            (parcelsRes.data ?? []).forEach((p) =>
              parcelMap.set(p.id, { intl_total_jpy: p.intl_total_jpy ?? null, intl_exchange_rate: p.intl_exchange_rate ?? null }),
            );
            const sibsByParent = new Map<string, Array<{ id: string; item_total_jpy: number | null; unit_price_jpy: number | null; quantity: number | null; weight_g: number | null; tariff_rate: number | null }>>();
            (siblingsRes.data ?? []).forEach((s) => {
              const k = s.parent_id as string;
              const arr = sibsByParent.get(k) ?? [];
              arr.push(s);
              sibsByParent.set(k, arr);
            });
            const landedById = new Map<string, number | null>();
            const jpyById = new Map<string, number | null>();
            for (const pid of parentIds) {
              const parcel = parcelMap.get(pid);
              const sibs = sibsByParent.get(pid) ?? [];
              if (!parcel || sibs.length === 0) continue;
              const m = computeParcelItemLanded(parcel, sibs);
              m.forEach((v, k) => {
                landedById.set(k, v.landedCny);
                jpyById.set(k, v.itemJpy);
              });
            }
            items.forEach((it) => {
              const landed = landedById.get(it.id) ?? null;
              it.landed_cny = round2(landed);
              const piece = computePiecePrice(jpyById.get(it.id) ?? it.item_total_jpy, landed, it.pack_pieces && it.pack_pieces > 0 ? it.pack_pieces : null);
              it.piece_price_cny = round2(piece.pieceCny);
              it.piece_price_jpy = piece.pieceJpy == null ? null : Math.round(piece.pieceJpy);
            });
          }

          return ok({
            mode: "item" as const,
            items,
            rows: [] as never[],
            has_more: items.length === limit,
            next_offset: offset + items.length,
          });
        }

        // ---------- parcel 模式 ----------
        let query = supabaseAdmin
          .from("japan_parcels")
          .select(
            "id, system_code, source_order_no, tracking_no, status, item_title, item_title_cn, item_image_url, seller, warehouse_location, purchased_at, intl_pay_at, received_at, grand_total_cny, is_problem, created_at, created_by, japan_parcel_items(item_title, item_title_cn, item_image_url, item_total_cny, quantity, position)",
          )
          .is("deleted_at", null)
          .in("status", statuses)
          .order("intl_pay_at", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false, nullsFirst: false })
          .range(from, to);

        if (q) {
          const s = `%${q}%`;
          query = query.or(
            `item_title.ilike.${s},item_title_cn.ilike.${s},source_order_no.ilike.${s},tracking_no.ilike.${s},seller.ilike.${s},system_code.ilike.${s}`,
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
            r.grand_total_cny != null ? Number(r.grand_total_cny) : itemsTotalCny > 0 ? itemsTotalCny : null;
          const avg = baseTotal != null && totalQty > 0 ? baseTotal / totalQty : null;
          return {
            id: r.id,
            system_code: r.system_code ?? null,
            source_order_no: r.source_order_no ?? null,
            tracking_no: r.tracking_no ?? null,
            status: r.status,
            is_problem: !!r.is_problem,
            seller: r.seller ?? null,
            warehouse_location: r.warehouse_location ?? null,
            purchased_at: r.purchased_at ?? null,
            intl_pay_at: r.intl_pay_at ?? null,
            received_at: r.received_at ?? null,
            created_at: r.created_at,
            created_by: r.created_by ?? null,
            first_item_name,
            item_image_url: firstImage,
            item_count: children.length,
            total_qty: totalQty,
            grand_total_cny: baseTotal != null ? round2(baseTotal) : null,
            avg_unit_cny: round2(avg),
          };
        });

        return ok({
          mode: "parcel" as const,
          items: [] as never[],
          rows: mapped,
          has_more: mapped.length === limit,
          next_offset: offset + mapped.length,
        });
      },
    },
  },
});
