// Zod-free consent primitives + outbound AI guard (safe to bundle into isolated tests/workers).
export const AI_POLICY_VERSION = "2026-10-09-v1" as const;

export type ConsentStore = {
  get(userId: string, policyVersion: string): Promise<boolean | null>;
  set(userId: string, policyVersion: string, allowed: boolean, deviceId: string | null): Promise<boolean>;
};

/** Authoritative check. Throws only when the store itself fails (callers must fail closed). */
export async function isAiAllowed(
  store: ConsentStore,
  userId: string | null | undefined,
  policyVersion: string | null | undefined,
): Promise<boolean> {
  if (!userId || policyVersion !== AI_POLICY_VERSION) return false;
  return (await store.get(userId, policyVersion)) === true;
}

/** Queue-side decision made right before each real AI call. */
export async function queuedAiDecision(
  store: ConsentStore,
  job: { ai_actor_user_id?: string | null; ai_policy_version?: string | null },
): Promise<"allowed" | "denied" | "unavailable"> {
  try {
    return (await isAiAllowed(store, job.ai_actor_user_id, job.ai_policy_version)) ? "allowed" : "denied";
  } catch {
    return "unavailable";
  }
}

export const QUEUED_AI_DENIED_ERROR = "ai_consent_missing: AI 授权未开启或已撤回，已保留原图";
export const QUEUED_AI_UNAVAILABLE_ERROR = "ai_consent_unavailable: 授权状态暂不可读，稍后重试";

// ---------------------------------------------------------------------------
// Outbound guard: checked immediately before EVERY real AI/research request.
// There is no default guard. Handheld callers bind the original staff actor +
// policy version; PC ERP callers must pass webErpAiGuard() explicitly.
// ---------------------------------------------------------------------------
export type AiGuardKind = "handheld_staff" | "web_erp";
export type AiOutboundGuard = { readonly kind: AiGuardKind; check(stage: string): Promise<void> };

export class AiConsentRevokedError extends Error {
  readonly code = "ai_consent_revoked" as const;
  readonly reason: "denied" | "unavailable";
  readonly guardStage: string;
  constructor(reason: "denied" | "unavailable", guardStage: string) {
    super(reason === "denied" ? QUEUED_AI_DENIED_ERROR : QUEUED_AI_UNAVAILABLE_ERROR);
    this.name = "AiConsentRevokedError";
    this.reason = reason;
    this.guardStage = guardStage;
  }
}

export function isAiConsentRevoked(error: unknown): error is AiConsentRevokedError {
  return error instanceof AiConsentRevokedError ||
    (!!error && typeof error === "object" && (error as { code?: unknown }).code === "ai_consent_revoked");
}

/** Re-reads actor + exact policy version on every check; any read failure fails closed. */
export function handheldAiGuard(
  store: ConsentStore,
  actor: { userId: string | null | undefined; policyVersion: string | null | undefined },
): AiOutboundGuard {
  return {
    kind: "handheld_staff",
    async check(stage) {
      const decision = await queuedAiDecision(store, {
        ai_actor_user_id: actor.userId,
        ai_policy_version: actor.policyVersion,
      });
      if (decision !== "allowed") throw new AiConsentRevokedError(decision, stage);
    },
  };
}

/** Only for PC ERP server functions already authorized by web role middleware. */
export function webErpAiGuard(): AiOutboundGuard {
  return { kind: "web_erp", async check() {} };
}

/** Call right before the outbound request. Missing/invalid guard fails closed. */
export async function beforeAiOutbound(guard: AiOutboundGuard | null | undefined, stage: string): Promise<void> {
  if (!guard || typeof guard.check !== "function" || (guard.kind !== "handheld_staff" && guard.kind !== "web_erp"))
    throw new AiConsentRevokedError("denied", stage);
  await guard.check(stage);
}

/** Handheld-only modules reject web guards so a web role is never treated as a handheld actor. */
export async function beforeHandheldAiOutbound(guard: AiOutboundGuard | null | undefined, stage: string): Promise<void> {
  if (!guard || guard.kind !== "handheld_staff") throw new AiConsentRevokedError("denied", stage);
  await beforeAiOutbound(guard, stage);
}
