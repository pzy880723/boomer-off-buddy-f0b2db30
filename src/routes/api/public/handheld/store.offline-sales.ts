// GET  /api/public/handheld/store/offline-sales?location_id=&date_from=&date_to=
// POST /api/public/handheld/store/offline-sales   线下补录（仅未进入有赞的现金/POS/微信等收款）
// 幂等：同门店同 client_op_id 只落一条，重复提交回放原记录并写审计。
import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  userCanAccessLocation,
  loadUserRoles,
  ok,
  err,
} from "@/server/handheld-auth.server";
import {
  createOfflineEntry,
  listOfflineEntries,
  type OfflineEntryInput,
} from "@/server/store-targets.server";
import { shanghaiToday } from "@/lib/store-targets/sales-window";

const CHANNELS = ["cash", "pos_card", "wechat_qr", "alipay_qr", "bank_transfer", "other"];
const EVIDENCE = [
  "pos_receipt",
  "payment_screenshot",
  "bank_slip",
  "handwritten_slip",
  "manual_declaration",
];
const EXCLUSION = [
  "device_not_youzan",
  "operator_declared",
  "reconciled_against_youzan",
  "unverified",
];

async function resolveLocation(request: Request, requested: string | null) {
  const auth = await authenticateDevice(request);
  if (!auth.ok) return { ok: false as const, response: auth.response };
  const session = await resolveSessionUser(request);
  let locationId = auth.device.location_id;

  if (requested && requested !== auth.device.location_id) {
    if (!session) {
      return {
        ok: false as const,
        response: err("Cross-location access requires a session", 401, {
          code: "session_required",
        }),
      };
    }
    if (!(await userCanAccessLocation(session.user_id, requested))) {
      return {
        ok: false as const,
        response: err("You do not have permission to operate this location", 403, {
          code: "location_forbidden",
        }),
      };
    }
    locationId = requested;
  } else if (session && locationId) {
    if (!(await userCanAccessLocation(session.user_id, locationId))) {
      return {
        ok: false as const,
        response: err("You do not have permission to operate this location", 403, {
          code: "location_forbidden",
        }),
      };
    }
  }
  if (!locationId) {
    return {
      ok: false as const,
      response: err("Device has no bound location", 400, { code: "location_required" }),
    };
  }
  return { ok: true as const, locationId, session };
}

export const Route = createFileRoute("/api/public/handheld/store/offline-sales")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: HANDHELD_CORS }),

      GET: async ({ request }) => {
        const url = new URL(request.url);
        const resolved = await resolveLocation(request, url.searchParams.get("location_id"));
        if (!resolved.ok) return resolved.response;

        const today = shanghaiToday();
        const dateFrom = url.searchParams.get("date_from") ?? today;
        const dateTo = url.searchParams.get("date_to") ?? today;
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
        const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);

        const result = await listOfflineEntries({
          locationId: resolved.locationId,
          dateFrom,
          dateTo,
          includeVoided: url.searchParams.get("include_voided") === "true",
          limit,
          offset,
        });
        return ok({ ...result, limit, offset, location_id: resolved.locationId });
      },

      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return err("Invalid JSON body", 400);
        }

        const resolved = await resolveLocation(request, (body["location_id"] as string) ?? null);
        if (!resolved.ok) return resolved.response;
        if (!resolved.session) {
          return err("Offline sales entry requires a signed-in staff session", 401, {
            code: "session_required",
          });
        }

        const channel = String(body["channel"] ?? "");
        const evidenceType = String(body["evidence_type"] ?? "");
        const exclusion = String(body["youzan_exclusion_basis"] ?? "");
        const amountFen = Number(body["amount_fen"]);
        const businessDate = String(body["business_date"] ?? shanghaiToday());
        const clientOpId = String(body["client_op_id"] ?? "");

        if (!CHANNELS.includes(channel))
          return err(`channel must be one of ${CHANNELS.join(",")}`, 400, {
            code: "invalid_channel",
          });
        if (!EVIDENCE.includes(evidenceType))
          return err(`evidence_type must be one of ${EVIDENCE.join(",")}`, 400, {
            code: "invalid_evidence_type",
          });
        if (!EXCLUSION.includes(exclusion))
          return err(`youzan_exclusion_basis must be one of ${EXCLUSION.join(",")}`, 400, {
            code: "invalid_exclusion_basis",
          });
        if (!Number.isInteger(amountFen) || amountFen === 0)
          return err("amount_fen must be a non-zero integer (fen)", 400, {
            code: "invalid_amount",
          });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate))
          return err("business_date must be yyyy-mm-dd", 400, { code: "invalid_date" });
        if (!clientOpId)
          return err("client_op_id is required for idempotency", 400, {
            code: "client_op_id_required",
          });

        const roles = await loadUserRoles(resolved.session.user_id);
        const input: OfflineEntryInput = {
          locationId: resolved.locationId,
          businessDate,
          channel: channel as OfflineEntryInput["channel"],
          amountFen,
          orderCount: Number(body["order_count"] ?? 1) || 0,
          evidenceType: evidenceType as OfflineEntryInput["evidenceType"],
          evidenceRef: (body["evidence_ref"] as string) ?? null,
          evidenceUrl: (body["evidence_url"] as string) ?? null,
          youzanExclusionBasis: exclusion as OfflineEntryInput["youzanExclusionBasis"],
          youzanExcludedTids: Array.isArray(body["youzan_excluded_tids"])
            ? (body["youzan_excluded_tids"] as string[])
            : [],
          note: (body["note"] as string) ?? null,
          clientOpId,
        };

        try {
          const result = await createOfflineEntry(input, {
            actorId: resolved.session.user_id,
            actorRole: roles[0] ?? null,
          });
          return ok(result);
        } catch (e) {
          return err((e as Error).message, 400, { code: "offline_entry_rejected" });
        }
      },
    },
  },
});
