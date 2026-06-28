import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RfidBatchStockInReq } from "@/lib/handheld/schemas";
import { replayIfPresent, recordOp } from "@/server/handheld-idempotency.server";

export const Route = createFileRoute("/api/public/handheld/rfid/batch-stock-in")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        let body: ReturnType<typeof RfidBatchStockInReq.parse>;
        try {
          body = RfidBatchStockInReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { code: "validation_error", detail: String(e) });
        }

        const results: Array<{
          client_op_id: string;
          replayed: boolean;
          queued: number;
          already_bound: Array<{ epc: string; sku_id: string }>;
        }> = [];

        for (const op of body.ops) {
          // 幂等回放
          const prior = await replayIfPresent({
            deviceId: auth.device.id,
            clientOpId: op.client_op_id,
            opType: "rfid.batch-stock-in",
          });
          if (prior) {
            const prev = (prior.response_json ?? {}) as any;
            results.push({
              client_op_id: op.client_op_id,
              replayed: true,
              queued: prev.queued ?? 0,
              already_bound: prev.already_bound ?? [],
            });
            continue;
          }

          // 去重
          const uniq = Array.from(new Set(op.epcs));
          // 已绑定的
          const { data: bound } = await supabaseAdmin
            .from("inv_epcs")
            .select("epc, sku_id")
            .in("epc", uniq);
          const boundSet = new Set((bound ?? []).map((r: any) => r.epc));
          const alreadyBound = (bound ?? []).map((r: any) => ({ epc: r.epc, sku_id: r.sku_id }));
          const toQueue = uniq.filter((e) => !boundSet.has(e));

          let queued = 0;
          if (toQueue.length > 0) {
            const rows = toQueue.map((epc) => ({
              epc,
              device_id: auth.device.id,
              location_id: auth.device.location_id,
              status: "pending" as const,
              scanned_at: op.scanned_at ?? new Date().toISOString(),
            }));
            const { error: upErr, count } = await supabaseAdmin
              .from("inv_unclaimed_epcs" as never)
              .upsert(rows as never, { onConflict: "epc", ignoreDuplicates: true, count: "exact" } as never);
            if (upErr) return err(`unclaimed upsert failed: ${upErr.message}`, 500);
            queued = count ?? toQueue.length;
          }

          const payload = { queued, already_bound: alreadyBound };
          await recordOp({
            deviceId: auth.device.id,
            clientOpId: op.client_op_id,
            opType: "rfid.batch-stock-in",
            status: 200,
            body: payload,
          });
          results.push({ client_op_id: op.client_op_id, replayed: false, ...payload });
        }

        return ok({ results });
      },
    },
  },
});
