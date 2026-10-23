import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err, resolveSessionUser } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveNotificationScope } from "@/server/handheld-notifications.server";
import {
  errorLabel,
  nextAction,
  reasonLabel,
  resolveSyncLocations,
  statusLabel,
  type LocationRow,
} from "@/server/handheld-sync-records";

type QueueRow = {
  id: string; sku_id: string; shop_id: string | null; location_id: string | null; target_stock: number;
  reason: string; status: string; attempts: number; last_error: string | null; created_at: string; updated_at: string;
};

export const Route = createFileRoute("/api/public/handheld/sync-records")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("需要员工登录", 401, { code: "session_required" });
        const url = new URL(request.url);
        const status = url.searchParams.get("status"); // pending | done | failed
        const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200));

        const scope = await resolveNotificationScope({
          userId: session.user_id,
          deviceId: auth.device.id,
          deviceLocationId: auth.device.location_id,
        });
        const locR = scope.location_ids.length
          ? await supabaseAdmin.from("inv_locations").select("id, name, kind, shop_id").in("id", scope.location_ids)
          : { data: [], error: null };
        if (locR.error) return err("同步记录读取失败，请稍后重试", 503, { code: "sync_records_unavailable" });
        const locs = (locR.data ?? []) as unknown as LocationRow[];
        const byId = new Map(locs.map((l) => [l.id, l]));
        const r = resolveSyncLocations(scope, url.searchParams.get("location_id"), (id) => byId.get(id)?.kind ?? null);
        if (!r.ok) {
          const msg = r.code === "location_forbidden" ? "无权查看该库位" : r.code === "location_required" ? "请先选择库位" : "库位参数无效";
          return err(msg, r.status, { code: r.code });
        }
        const shopIds = [...new Set(r.locationIds.map((id) => byId.get(id)?.shop_id).filter((v): v is string => !!v))];
        const ors = [`location_id.in.(${r.locationIds.join(",")})`];
        // 明确 location_id 优先；只有 location_id 为空的旧记录才按库位对应的有赞门店匹配，避免共享 shop_id 的他店记录漏入。
        if (shopIds.length) ors.push(`and(location_id.is.null,shop_id.in.(${shopIds.join(",")}))`);

        let qb = supabaseAdmin
          .from("youzan_stock_sync_queue")
          .select("id, sku_id, shop_id, location_id, target_stock, reason, status, attempts, last_error, created_at, updated_at")
          .or(ors.join(","))
          .order("created_at", { ascending: false })
          .limit(limit);
        if (status) qb = qb.eq("status", status);
        const { data, error } = await qb;
        if (error) return err("同步记录读取失败，请稍后重试", 503, { code: "sync_records_unavailable" });
        const rows = (data ?? []) as unknown as QueueRow[];

        const skuIds = [...new Set(rows.map((x) => x.sku_id))];
        const rowShopIds = [...new Set(rows.map((x) => x.shop_id).filter((v): v is string => !!v))];
        const [skuR, shopR] = await Promise.all([
          skuIds.length ? supabaseAdmin.from("inv_skus").select("id, name").in("id", skuIds) : Promise.resolve({ data: [], error: null }),
          rowShopIds.length ? supabaseAdmin.from("youzan_shops").select("id, shop_name").in("id", rowShopIds) : Promise.resolve({ data: [], error: null }),
        ]);
        if (skuR.error || shopR.error) return err("同步记录读取失败，请稍后重试", 503, { code: "sync_records_unavailable" });
        const skuName = new Map(((skuR.data ?? []) as { id: string; name: string | null }[]).map((s) => [s.id, s.name]));
        const shopName = new Map(((shopR.data ?? []) as { id: string; shop_name: string | null }[]).map((s) => [s.id, s.shop_name]));
        const locByShop = new Map(locs.filter((l) => l.shop_id).map((l) => [l.shop_id as string, l]));

        const items = rows.map((x) => {
          const loc = x.location_id ? byId.get(x.location_id) : x.shop_id ? locByShop.get(x.shop_id) : undefined;
          return {
            ...x,
            sku_name: skuName.get(x.sku_id)?.trim() || "未命名商品",
            shop_name: (x.shop_id && shopName.get(x.shop_id)?.trim()) || "未关联有赞门店",
            location_name: loc?.name?.trim() || "未关联库位",
            status_label: statusLabel(x.status),
            reason_label: reasonLabel(x.reason),
            next_action: nextAction(x.status),
            error_label: errorLabel(x.last_error),
          };
        });
        return ok({ items, location_id: r.current });
      },
    },
  },
});
