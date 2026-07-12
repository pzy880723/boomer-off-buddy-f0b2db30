import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const STOREFRONT_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

export function storefrontJson(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...STOREFRONT_CORS,
      ...(init.headers || {}),
    },
  });
}

export function storefrontError(message: string, status = 400, code?: string) {
  return storefrontJson({ ok: false, error: message, ...(code ? { code } : {}) }, { status });
}

export async function authenticateStorefrontUser(
  request: Request,
): Promise<
  { ok: true; user: { id: string; email: string | null } } | { ok: false; response: Response }
> {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, response: storefrontError("Authentication required", 401) };
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return { ok: false, response: storefrontError("Invalid session", 401) };
  }
  return {
    ok: true,
    user: { id: data.user.id, email: data.user.email ?? null },
  };
}
