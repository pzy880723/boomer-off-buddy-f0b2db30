import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  err,
  json,
  ok,
  resolveSessionUser,
  userCanAccessLocation,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { SyncYouzanReq } from "@/lib/handheld/schemas";
import { jsonReplay, recordOp, replayIfPresent } from "@/server/handheld-idempotency.server";
import { releaseSkuToOfflineShopsCore } from "@/lib/youzan-offline-products.functions";
import { assignSkuToYouzanCategoryGroups } from "@/lib/youzan-category-groups.server";

export const Route = createFileRoute("/api/public/handheld/items/$id/sync-youzan")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Missing session token", 401, { code: "unauthorized" });

        let body: ReturnType<typeof SyncYouzanReq.parse>;
        try {
          body = SyncYouzanReq.parse(await request.json());
        } catch (error) {
          return err("Invalid body", 400, {
            code: "validation_error",
            detail: String(error),
          });
        }

        const replay = await replayIfPresent({
          deviceId: auth.device.id,
          clientOpId: body.client_op_id,
          opType: "items.sync-youzan",
        });
        if (replay) return jsonReplay(replay);

        const locationId = body.location_id ?? auth.device.location_id;
        if (!locationId) {
          return err("Select a target shop location", 400, { code: "location_required" });
        }
        if (!(await userCanAccessLocation(session.user_id, locationId))) {
          return err("You do not have permission to operate this location", 403, {
            code: "location_forbidden",
          });
        }

        const [{ data: location }, { data: sku, error: skuError }] = await Promise.all([
          supabaseAdmin
            .from("inv_locations")
            .select("id, kind, shop_id, is_active")
            .eq("id", locationId)
            .maybeSingle(),
          supabaseAdmin
            .from("inv_skus")
            .select("id, is_custom_price")
            .eq("id", params.id)
            .maybeSingle(),
        ]);
        if (!location || !location.is_active) {
          return err("Location not found or disabled", 404, { code: "location_not_found" });
        }
        if (location.kind !== "shop" || !location.shop_id) {
          return err("Select a shop location linked to Youzan", 422, {
            code: "shop_location_required",
          });
        }
        if (skuError) return err(skuError.message, 500, { code: "database_error" });
        if (!sku) return err("SKU not found", 404, { code: "not_found" });
        if (!sku.is_custom_price) {
          return err("Only custom products can use handheld Youzan publication", 422, {
            code: "custom_product_required",
          });
        }

        const release = await releaseSkuToOfflineShopsCore({
          sku_id: params.id,
          shop_ids: [location.shop_id],
        });
        if (release.ok) await assignSkuToYouzanCategoryGroups(params.id);
        const responseData = {
          sku_id: params.id,
          location_id: location.id,
          shop_id: location.shop_id,
          status: release.ok ? ("queued" as const) : ("failed" as const),
          results: release.results,
        };
        const status = release.ok ? 200 : 502;
        const responseBody = release.ok
          ? { ok: true, data: responseData }
          : {
              ok: false,
              error: "Youzan publication failed",
              code: "youzan_publish_failed",
              data: responseData,
            };
        await recordOp({
          deviceId: auth.device.id,
          clientOpId: body.client_op_id,
          opType: "items.sync-youzan",
          status,
          body: responseBody,
        });
        return release.ok ? ok(responseData) : json(responseBody, { status });
      },
    },
  },
});
