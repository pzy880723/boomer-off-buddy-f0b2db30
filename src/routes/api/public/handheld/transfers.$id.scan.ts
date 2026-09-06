import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { getTransfer, recordScan } from "@/server/handheld-transfer.server";

export const Route = createFileRoute("/api/public/handheld/transfers/$id/scan")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const need = requireLocation(auth.device);
        if (!need.ok) return need.response;

        let body: { epcs?: string[]; epc?: string };
        try {
          body = (await request.json()) as { epcs?: string[]; epc?: string };
        } catch {
          return err("Invalid body", 400, { code: "invalid_body" });
        }
        const epcs = Array.isArray(body.epcs) ? body.epcs : body.epc ? [body.epc] : [];
        if (epcs.length === 0) return err("epcs required", 400, { code: "validation_error" });

        const t = await getTransfer(params.id);
        if (!t) return err("Not found", 404, { code: "not_found" });

        const locId = auth.device.location_id!;
        let side: "ship" | "receive";
        if (t.from_location_id === locId && ["draft", "pending", "shipping"].includes(t.status)) {
          side = "ship";
        } else if (t.to_location_id === locId && ["shipped", "in_transit"].includes(t.status)) {
          side = "receive";
        } else {
          return err(`Cannot scan transfer ${t.status} from this location`, 409, {
            code: "wrong_stage",
          });
        }

        const result = await recordScan(side, params.id, epcs, auth.device);
        return ok({ side, ...result });
      },
    },
  },
});
