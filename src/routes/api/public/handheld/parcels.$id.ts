/**
 * GET /api/public/handheld/parcels/{id}
 * 包裹详情 + items + 服务端已算好的拆包成本（landed）。super_admin 独占。
 */
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, ok } from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  computeParcelItemLanded,
  computePiecePrice,
  sumTariffJpy,
  type ParcelStatus,
} from "@/lib/japan-parcel.helpers";
import { requireSuperAdmin } from "./parcels";
import { z } from "zod";

export const Route = createFileRoute("/api/public/handheld/parcels/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const g = await requireSuperAdmin(request);
        if (!g.ok) return g.response;

        const idParse = z.string().uuid().safeParse(params.id);
        if (!idParse.success) return errCode("invalid_body", "Invalid parcel id");
        const parcelId = idParse.data;

        const { data: row, error } = await supabaseAdmin
          .from("japan_parcels")
          .select(
            "id, system_code, source_order_no, tracking_no, status, is_problem, seller, warehouse_location, item_title, item_title_cn, item_image_url, receiver_name, receiver_address, total_weight_g, weight_g, purchased_at, intl_pay_at, received_at, notes, created_at, created_by, status_timeline, intl_total_jpy, intl_exchange_rate, deleted_at",
          )
          .eq("id", parcelId)
          .maybeSingle();
        if (error) return errCode("internal_error", error.message);
        if (!row || row.deleted_at) return errCode("not_found", "Parcel not found");

        const { data: items, error: itemsErr } = await supabaseAdmin
          .from("japan_parcel_items")
          .select(
            "id, position, system_code, sub_order_no, merchant_order_no, source_platform, condition, addon_service, item_title, item_title_cn, item_image_url, quantity, unit_price_jpy, item_total_jpy, item_total_cny, weight_g, exchange_rate, service_fee_jpy, domestic_freight_jpy, freight_diff_jpy, tariff_rate, tariff_category, pay_at, pay_method, notes, arrival_photo_urls, created_by, created_at, pack_pieces, pack_pieces_source, pack_unit_note",
          )
          .eq("parent_id", parcelId)
          .order("position", { ascending: true });
        if (itemsErr) return errCode("internal_error", itemsErr.message);

        const list = items ?? [];
        const landedMap = computeParcelItemLanded(
          {
            intl_total_jpy: row.intl_total_jpy ?? null,
            intl_exchange_rate: row.intl_exchange_rate ?? null,
          },
          list.map((it) => ({
            id: it.id,
            item_total_jpy: it.item_total_jpy ?? null,
            unit_price_jpy: it.unit_price_jpy ?? null,
            quantity: it.quantity ?? null,
            weight_g: it.weight_g ?? null,
            tariff_rate: it.tariff_rate ?? null,
          })),
        );

        const round2 = (v: number | null | undefined) =>
          v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100;

        const itemsOut = list.map((it) => {
          const l = landedMap.get(it.id);
          const qty = Number(it.quantity) || 0;
          const landedCny = l?.landedCny ?? null;
          const unitPriceCny = qty > 0 && landedCny != null ? landedCny / qty : null;
          const piece = computePiecePrice(l?.itemJpy ?? null, landedCny, it.pack_pieces ?? null);
          return {
            id: it.id,
            position: it.position ?? null,
            system_code: it.system_code ?? null,
            sub_order_no: it.sub_order_no ?? null,
            merchant_order_no: it.merchant_order_no ?? null,
            source_platform: it.source_platform ?? null,
            condition: it.condition ?? null,
            addon_service: it.addon_service ?? null,
            item_title: it.item_title ?? null,
            item_title_cn: it.item_title_cn ?? null,
            item_image_url: it.item_image_url ?? null,
            quantity: it.quantity ?? null,
            unit_price_jpy: it.unit_price_jpy ?? null,
            item_total_jpy: it.item_total_jpy ?? null,
            item_total_cny: it.item_total_cny ?? null,
            weight_g: it.weight_g ?? null,
            exchange_rate: it.exchange_rate ?? null,
            service_fee_jpy: it.service_fee_jpy ?? null,
            domestic_freight_jpy: it.domestic_freight_jpy ?? null,
            freight_diff_jpy: it.freight_diff_jpy ?? null,
            tariff_rate: it.tariff_rate ?? null,
            tariff_category: it.tariff_category ?? null,
            pay_at: it.pay_at ?? null,
            pay_method: it.pay_method ?? null,
            notes: it.notes ?? null,
            arrival_photo_urls: Array.isArray(it.arrival_photo_urls) ? it.arrival_photo_urls : [],
            created_by: it.created_by ?? null,
            created_at: it.created_at ?? null,
            pack_pieces: it.pack_pieces ?? null,
            pack_pieces_source: it.pack_pieces_source ?? null,
            pack_unit_note: it.pack_unit_note ?? null,
            landed: {
              item_jpy: Math.round(l?.itemJpy ?? 0),
              freight_share_jpy: Math.round(l?.freightShareJpy ?? 0),
              item_cny: round2(l?.itemCny ?? null),
              freight_share_cny: round2(l?.freightShareCny ?? null),
              tariff_cny: round2(l?.tariffCny ?? null),
              landed_cny: round2(landedCny),
              unit_price_cny: round2(unitPriceCny),
              piece_price_jpy: piece.pieceJpy == null ? null : Math.round(piece.pieceJpy),
              piece_price_cny: round2(piece.pieceCny),
            },
          };
        });

        const rate = Number(row.intl_exchange_rate) || 0;
        const itemsJpy = itemsOut.reduce((s, it) => s + it.landed.item_jpy, 0);
        const intlJpy = row.intl_total_jpy != null ? Number(row.intl_total_jpy) : null;
        const tariffJpy = sumTariffJpy(
          list.map((it) => ({
            item_total_jpy: it.item_total_jpy ?? null,
            tariff_rate: it.tariff_rate ?? null,
          })),
        );
        const itemsCny = rate > 0 ? round2(itemsJpy * rate) : null;
        const intlCny = rate > 0 && intlJpy != null ? round2(intlJpy * rate) : null;
        const tariffCny = rate > 0 ? round2(tariffJpy * rate) : null;
        const totalCny =
          rate > 0 ? round2((itemsCny ?? 0) + (intlCny ?? 0) + (tariffCny ?? 0)) : null;

        const first = list[0];
        const first_item_name = first
          ? first.item_title_cn || first.item_title || null
          : row.item_title_cn || row.item_title || null;
        const first_image =
          row.item_image_url || list.find((c) => c.item_image_url)?.item_image_url || null;

        return ok({
          parcel: {
            id: row.id,
            system_code: row.system_code ?? null,
            source_order_no: row.source_order_no ?? null,
            tracking_no: row.tracking_no ?? null,
            status: row.status as ParcelStatus,
            is_problem: !!row.is_problem,
            seller: row.seller ?? null,
            warehouse_location: row.warehouse_location ?? null,
            receiver_name: row.receiver_name ?? null,
            receiver_address: row.receiver_address ?? null,
            total_weight_g: row.total_weight_g ?? null,
            weight_g: row.weight_g ?? null,
            purchased_at: row.purchased_at ?? null,
            intl_pay_at: row.intl_pay_at ?? null,
            received_at: row.received_at ?? null,
            notes: row.notes ?? null,
            created_at: row.created_at,
            created_by: row.created_by ?? null,
            item_image_url: first_image,
            first_item_name,
            status_timeline: Array.isArray(row.status_timeline) ? row.status_timeline : [],
          },
          totals: {
            items_jpy: itemsJpy,
            items_cny: itemsCny,
            intl_total_jpy: intlJpy,
            intl_total_cny: intlCny,
            tariff_jpy: tariffJpy,
            tariff_cny: tariffCny,
            fx_rate: row.intl_exchange_rate ?? null,
            total_cny: totalCny,
          },
          items: itemsOut,
        });
      },
    },
  },
});
