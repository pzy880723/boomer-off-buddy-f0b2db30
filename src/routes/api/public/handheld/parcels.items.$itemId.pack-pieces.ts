/**
 * POST /api/public/handheld/parcels/items/{itemId}/pack-pieces
 * super_admin 独占。写入 japan_parcel_items 的拆包件数字段并返回最新单件价。
 *
 * body: { pack_pieces, pack_pieces_source, pack_unit_note }
 */
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, ok } from "@/server/handheld-auth.server";
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSuperAdmin } from "./parcels";
import { ParcelPackPiecesReq } from "@/lib/handheld/schemas";
import { computeParcelItemLanded, computePiecePrice } from "@/lib/japan-parcel.helpers";
import { z } from "zod";

export const Route = createFileRoute("/api/public/handheld/parcels/items/$itemId/pack-pieces")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const g = await requireSuperAdmin(request);
        if (!g.ok) return g.response;

        const idParse = z.string().uuid().safeParse(params.itemId);
        if (!idParse.success) return errCode("invalid_body", "Invalid item id");
        const itemId = idParse.data;

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return errCode("invalid_body", "Invalid JSON body");
        }
        const parsed = ParcelPackPiecesReq.safeParse(body);
        if (!parsed.success) {
          return errCode("validation_error", parsed.error.message, {
            issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
        }
        const { pack_pieces, pack_pieces_source, pack_unit_note } = parsed.data;

        const patch = {
          pack_pieces: pack_pieces && pack_pieces > 0 ? pack_pieces : null,
          pack_pieces_source: pack_pieces && pack_pieces > 0 ? (pack_pieces_source ?? "manual") : null,
          pack_unit_note: pack_pieces && pack_pieces > 0 ? (pack_unit_note?.trim() || "个") : null,
        };

        const { data: row, error } = await supabaseAdmin
          .from("japan_parcel_items")
          .update(patch)
          .eq("id", itemId)
          .select("id, parent_id, item_total_jpy, unit_price_jpy, quantity, weight_g, tariff_rate, pack_pieces, pack_pieces_source, pack_unit_note")
          .maybeSingle();
        if (error) return errCode("internal_error", error.message);
        if (!row) return errCode("not_found", "Parcel item not found");

        // 重新算这一件的 piece_price
        let piece_price_cny: number | null = null;
        let piece_price_jpy: number | null = null;
        if (row.parent_id) {
          const [pRes, sibRes] = await Promise.all([
            supabaseAdmin
              .from("japan_parcels")
              .select("intl_total_jpy, intl_exchange_rate")
              .eq("id", row.parent_id)
              .maybeSingle(),
            supabaseAdmin
              .from("japan_parcel_items")
              .select("id, parent_id, item_total_jpy, unit_price_jpy, quantity, weight_g, tariff_rate")
              .eq("parent_id", row.parent_id),
          ]);
          if (pRes.data) {
            const m = computeParcelItemLanded(
              { intl_total_jpy: pRes.data.intl_total_jpy ?? null, intl_exchange_rate: pRes.data.intl_exchange_rate ?? null },
              sibRes.data ?? [],
            );
            const l = m.get(row.id);
            const piece = computePiecePrice(l?.itemJpy ?? row.item_total_jpy ?? null, l?.landedCny ?? null, row.pack_pieces ?? null);
            piece_price_cny = piece.pieceCny == null ? null : Math.round(piece.pieceCny * 100) / 100;
            piece_price_jpy = piece.pieceJpy == null ? null : Math.round(piece.pieceJpy);
          }
        }

        return ok({
          id: row.id,
          pack_pieces: row.pack_pieces ?? null,
          pack_pieces_source: row.pack_pieces_source ?? null,
          pack_unit_note: row.pack_unit_note ?? null,
          piece_price_cny,
          piece_price_jpy,
        });
      },
    },
  },
});
