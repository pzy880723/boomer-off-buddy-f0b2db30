import { createFileRoute } from "@tanstack/react-router";
import { GO_PROJECT_REF } from "@/lib/go-bridge/constants";
import { nextRetryAt } from "@/lib/go-bridge/sync-state";

/**
 * GO ← ERP 授权同步通道（service-role bearer 调用）。
 *
 * action = "pull"  拉取待同步的角色/门店/身份/映射变更 + 完整门店编号目录
 * action = "ack"   回执：GO 已应用（ok=true）或失败（ok=false + error）
 *
 * 契约：ERP 是授权唯一真源；GO 收到 revoke 必须立刻生效，
 * ERP 在收到 ack 之前对该用户 fail closed。
 */
type Body = {
  action?: "pull" | "ack";
  limit?: number;
  results?: { id: string; ok: boolean; error?: string }[];
};

type OutboxRow = {
  id: string;
  subject_type: string;
  subject_key: string;
  target_user_id: string | null;
  change_kind: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  version: number;
};

export const Route = createFileRoute("/api/public/go/scope-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
        const authorization = request.headers.get("authorization") ?? "";
        if (!serviceRoleKey || authorization !== `Bearer ${serviceRoleKey}`) {
          return Response.json({ ok: false, code: "unauthorized" }, { status: 401 });
        }

        let body: Body = {};
        try {
          body = ((await request.json()) as Body) ?? {};
        } catch {
          body = {};
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sb = supabaseAdmin as unknown as { from: (t: string) => any };
        const nowIso = new Date().toISOString();

        try {
          if (body.action === "ack") {
            const results = Array.isArray(body.results) ? body.results : [];
            if (results.length === 0) {
              return Response.json({ ok: false, code: "empty_ack" }, { status: 400 });
            }
            let synced = 0;
            let failed = 0;
            for (const r of results) {
              if (r.ok) {
                const { error } = await sb
                  .from("go_scope_sync_outbox")
                  .update({ status: "synced", synced_at: nowIso, last_error: null })
                  .eq("id", r.id)
                  .eq("go_project_ref", GO_PROJECT_REF);
                if (error) throw new Error(error.message);
                synced += 1;
              } else {
                const cur = await sb
                  .from("go_scope_sync_outbox")
                  .select("attempts")
                  .eq("id", r.id)
                  .maybeSingle();
                if (cur.error) throw new Error(cur.error.message);
                const attempts = ((cur.data as { attempts: number } | null)?.attempts ?? 0) + 1;
                const { error } = await sb
                  .from("go_scope_sync_outbox")
                  .update({
                    status: "failed",
                    attempts,
                    last_error: (r.error ?? "unknown").slice(0, 500),
                    next_attempt_at: nextRetryAt(attempts, new Date()),
                  })
                  .eq("id", r.id)
                  .eq("go_project_ref", GO_PROJECT_REF);
                if (error) throw new Error(error.message);
                failed += 1;
              }
            }
            return Response.json({ ok: true, synced, failed });
          }

          // 默认 pull
          const limit = Math.min(Math.max(body.limit ?? 100, 1), 500);
          const pending = await sb
            .from("go_scope_sync_outbox")
            .select(
              "id, subject_type, subject_key, target_user_id, change_kind, payload, status, attempts, version",
            )
            .eq("go_project_ref", GO_PROJECT_REF)
            .neq("status", "synced")
            .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
            .order("created_at", { ascending: true })
            .limit(limit);
          if (pending.error) throw new Error(pending.error.message);

          const links = await sb
            .from("go_shop_location_links")
            .select("go_shop_id, location_id, status")
            .eq("go_project_ref", GO_PROJECT_REF)
            .eq("status", "active");
          if (links.error) throw new Error(links.error.message);
          const linkRows = (links.data ?? []) as { go_shop_id: string; location_id: string }[];

          const shopIds = linkRows.map((l) => l.location_id);
          let shops: { go_shop_id: string; erp_location_id: string; name: string }[] = [];
          if (shopIds.length > 0) {
            const locs = await sb
              .from("inv_locations")
              .select("id, name, kind, is_active")
              .in("id", shopIds)
              .eq("kind", "shop")
              .eq("is_active", true);
            if (locs.error) throw new Error(locs.error.message);
            const byId = new Map(
              ((locs.data ?? []) as { id: string; name: string }[]).map((l) => [l.id, l.name]),
            );
            shops = linkRows
              .filter((l) => byId.has(l.location_id))
              .map((l) => ({
                go_shop_id: l.go_shop_id,
                erp_location_id: l.location_id,
                name: byId.get(l.location_id) as string,
              }));
          }

          return Response.json({
            ok: true,
            go_project_ref: GO_PROJECT_REF,
            generated_at: nowIso,
            /** 跨项目门店编号唯一真源：只含显式 active 映射 */
            shops,
            changes: ((pending.data ?? []) as OutboxRow[]).map((r) => ({
              id: r.id,
              subject_type: r.subject_type,
              subject_key: r.subject_key,
              erp_user_id: r.target_user_id,
              change_kind: r.change_kind,
              payload: r.payload,
              attempts: r.attempts,
              version: r.version,
            })),
          });
        } catch (e) {
          return Response.json(
            { ok: false, code: "sync_failed", message: (e as Error).message },
            { status: 500 },
          );
        }
      },
    },
  },
});
