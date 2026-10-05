/** Output-only presentation fields; never serialize auth metadata or sender IDs. */
export type SupportSenderRole = "customer" | "store_staff" | "hq_agent" | "system";
export type SupportSenderPresentation = {
  sender_avatar_url: string | null;
  sender_role: SupportSenderRole;
  sender_location_name: string | null;
};

/** Conservative public-image policy: no credentials, queries, fragments, private hosts or signed paths. */
export function safePublicAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        (url.port && url.port !== "443") || !host.includes(".") ||
        /^[\d.]+$/.test(host) || host.includes(":") ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
        /\/(?:sign|signed|private|authenticated)(?:\/|$)/i.test(decodeURIComponent(url.pathname))) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function senderPresentation(input: {
  sender_type: string;
  sender_customer_id: string | null;
  conversation_customer_id: string | null;
  participant_role?: string | null;
  customer_avatar_url?: unknown;
  store_avatar_url?: unknown;
  hq_avatar_url?: unknown;
  location_name?: string | null;
}): SupportSenderPresentation {
  if (input.sender_type === "customer") return {
    sender_role: "customer",
    sender_avatar_url: input.sender_customer_id === input.conversation_customer_id && input.conversation_customer_id
      ? safePublicAvatarUrl(input.customer_avatar_url) : null,
    sender_location_name: null,
  };
  if (input.sender_type === "staff" && input.participant_role === "hq_agent") return {
    sender_role: "hq_agent", sender_avatar_url: safePublicAvatarUrl(input.hq_avatar_url), sender_location_name: null,
  };
  if (input.sender_type === "staff" && input.participant_role === "store_staff") return {
    sender_role: "store_staff", sender_avatar_url: safePublicAvatarUrl(input.store_avatar_url),
    sender_location_name: input.location_name ?? null,
  };
  // Missing/unknown historical participant: do not guess the current owner's identity or role.
  return { sender_role: "system", sender_avatar_url: null, sender_location_name: null };
}