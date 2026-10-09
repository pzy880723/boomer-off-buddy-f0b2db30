// Server bindings for the handheld AI consent contract.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  authenticateDevice,
  err,
  resolveSessionUser,
  type DeviceContext,
} from "@/server/handheld-auth.server";
import {
  AI_CONSENT_MESSAGE,
  AI_POLICY_VERSION,
  isAiAllowed,
  type ConsentStore,
} from "@/server/ai-consent-core";

const T = "handheld_ai_consents" as never;

export function dbConsentStore(): ConsentStore {
  return {
    async get(userId, policyVersion) {
      const { data, error } = await (supabaseAdmin.from(T) as any)
        .select("allowed")
        .eq("user_id", userId)
        .eq("policy_version", policyVersion)
        .maybeSingle();
      if (error) throw new Error("consent read failed");
      return data ? data.allowed === true : null;
    },
    async set(userId, policyVersion, allowed, deviceId) {
      const { data, error } = await (supabaseAdmin.from(T) as any)
        .upsert(
          { user_id: userId, policy_version: policyVersion, allowed, device_id: deviceId, decided_at: new Date().toISOString() },
          { onConflict: "user_id,policy_version" },
        )
        .select("allowed")
        .single();
      if (error || !data) throw new Error("consent write failed");
      return data.allowed === true;
    },
  };
}

export function aiConsentDeniedResponse() {
  return err(AI_CONSENT_MESSAGE, 403, { code: "ai_consent_required", policy_version: AI_POLICY_VERSION });
}

/** Returns a Response when AI must not run for this user; null when allowed. Fails closed. */
export async function aiConsentBlock(userId: string, store: ConsentStore = dbConsentStore()): Promise<Response | null> {
  try {
    return (await isAiAllowed(store, userId, AI_POLICY_VERSION)) ? null : aiConsentDeniedResponse();
  } catch {
    return err("授权状态暂不可用，请稍后重试", 503, { code: "consent_unavailable" });
  }
}

/** Device + employee session + current-version consent. */
export async function requireAiActor(request: Request): Promise<
  | { ok: true; device: DeviceContext; userId: string }
  | { ok: false; response: Response }
> {
  const auth = await authenticateDevice(request);
  if (!auth.ok) return auth;
  const session = await resolveSessionUser(request);
  if (!session) return { ok: false, response: err("Employee session required", 401, { code: "session_required" }) };
  const blocked = await aiConsentBlock(session.user_id);
  if (blocked) return { ok: false, response: blocked };
  return { ok: true, device: auth.device, userId: session.user_id };
}
