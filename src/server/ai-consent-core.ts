// Handheld AI consent contract (pure; no DB imports so it can be unit-tested).
// A staff user may use AI only when an explicit allowed=true row exists for the
// CURRENT policy version. Missing row, older version or read failure => no AI.
import { z } from "zod";

export const AI_POLICY_VERSION = "2026-10-09-v1" as const;

export type ConsentStore = {
  get(userId: string, policyVersion: string): Promise<boolean | null>;
  set(userId: string, policyVersion: string, allowed: boolean, deviceId: string | null): Promise<boolean>;
};

export const AI_CONSENT_MESSAGE = "AI 处理未授权：请在 App「设置 › AI 授权」中同意后重试；手动录入、浏览、收银和打印不受影响";

/** Authoritative check. Throws only when the store itself fails (callers must fail closed). */
export async function isAiAllowed(
  store: ConsentStore,
  userId: string | null | undefined,
  policyVersion: string | null | undefined,
): Promise<boolean> {
  if (!userId || policyVersion !== AI_POLICY_VERSION) return false;
  return (await store.get(userId, policyVersion)) === true;
}

export const ConsentBody = z
  .object({ allowed: z.boolean(), policy_version: z.string().min(1).max(64) })
  .strict();

export type ConsentResult = { status: number; body: Record<string, unknown> };

const fail = (status: number, code: string, error: string): ConsentResult => ({
  status,
  body: { ok: false, error, code },
});

/** userId MUST come from the verified session; the body cannot name a user. */
export async function handleConsentWrite(input: {
  store: ConsentStore;
  userId: string | null;
  deviceId: string | null;
  raw: unknown;
}): Promise<ConsentResult> {
  if (!input.userId) return fail(401, "session_required", "Employee session required");
  const parsed = ConsentBody.safeParse(input.raw);
  if (!parsed.success) return fail(422, "validation_error", "Invalid request");
  if (parsed.data.policy_version !== AI_POLICY_VERSION)
    return fail(409, "policy_version_mismatch", `当前政策版本为 ${AI_POLICY_VERSION}，请更新 App 后重新确认`);
  try {
    const stored = await input.store.set(input.userId, AI_POLICY_VERSION, parsed.data.allowed, input.deviceId);
    return { status: 200, body: { ok: true, data: { allowed: stored, policy_version: AI_POLICY_VERSION } } };
  } catch {
    return fail(503, "consent_unavailable", "授权保存失败，请稍后重试");
  }
}

export async function handleConsentRead(input: { store: ConsentStore; userId: string | null }): Promise<ConsentResult> {
  if (!input.userId) return fail(401, "session_required", "Employee session required");
  try {
    const allowed = await isAiAllowed(input.store, input.userId, AI_POLICY_VERSION);
    return { status: 200, body: { ok: true, data: { allowed, policy_version: AI_POLICY_VERSION } } };
  } catch {
    return fail(503, "consent_unavailable", "授权状态暂不可用，请稍后重试");
  }
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

/** smart-create: false => never queue; true/undefined => still requires DB consent. */
export function smartCreateWantsAi(flag: boolean | undefined): boolean {
  return flag !== false;
}
