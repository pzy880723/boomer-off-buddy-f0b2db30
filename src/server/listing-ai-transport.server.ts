// Controlled transport for listing-image AI calls only (detection, generation, validation).
// No LISTING_AI_RELAY_URL: legacy direct gateway call with LOVABLE_API_KEY.
// Configured: must equal the fixed relay URL exactly and authenticates with the service-role Bearer;
// any other value or a missing service-role key fails closed (never silently falls back to direct).
export const LISTING_AI_DIRECT_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
export const LISTING_AI_RELAY_FIXED_URL = "https://boomer-off-buddy.lovable.app/api/public/hooks/listing-ai-relay";
export const LISTING_AI_ALLOWED_MODELS = ["google/gemini-2.5-flash", "google/gemini-3.1-flash-image", "google/gemini-2.5-flash-image"] as const;

type Env = Record<string, string | undefined>;

export class ListingAiTransportConfigError extends Error {
  constructor(message: string) { super(`permanent: ${message}`); this.name = "ListingAiTransportConfigError"; }
}

export function listingAiTarget(gatewayKey: string, env: Env = process.env): { url: string; authorization: string; via: "direct" | "relay" } {
  const relay = env.LISTING_AI_RELAY_URL?.trim();
  if (!relay) return { url: LISTING_AI_DIRECT_URL, authorization: `Bearer ${gatewayKey}`, via: "direct" };
  if (relay !== LISTING_AI_RELAY_FIXED_URL) throw new ListingAiTransportConfigError("LISTING_AI_RELAY_URL not allowed");
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRole) throw new ListingAiTransportConfigError("relay auth unavailable");
  return { url: LISTING_AI_RELAY_FIXED_URL, authorization: `Bearer ${serviceRole}`, via: "relay" };
}

/** POST a chat-completions JSON body through the configured listing AI transport. */
export async function listingAiFetch(body: string, gatewayKey: string, signal: AbortSignal | undefined,
  extraHeaders: Record<string, string> = {}, env: Env = process.env): Promise<Response> {
  const target = listingAiTarget(gatewayKey, env);
  return fetch(target.url, { method: "POST", signal, redirect: "error",
    headers: { ...extraHeaders, Authorization: target.authorization, "Content-Type": "application/json" }, body });
}
