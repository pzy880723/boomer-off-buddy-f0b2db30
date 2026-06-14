import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, requireLocation } from "@/server/handheld-auth.server";
import { ScanBody, getTransfer, recordScan, ok, err } from "@/server/handheld-transfer.server";

export const Route = createFileRoute("/api/public/handheld/transfer/receive-scan")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const need = requireLocation(auth.device);
        if (!need.ok) return need.response;
        let body;
        try {
          body = ScanBody.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }
        const t = await getTransfer(body.transfer_id);
        if (!t) return err("Not found", 404);
        if (t.to_location_id !== auth.device.location_id)
          return err("Not the to-location of this transfer", 403);
        if (t.status !== "in_transit") return err(`Transfer is ${t.status}`, 409);
        const result = await recordScan("receive", body.transfer_id, body.epcs, auth.device);
        return ok(result);
      },
    },
  },
});
