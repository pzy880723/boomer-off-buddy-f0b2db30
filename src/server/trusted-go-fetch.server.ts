import { GO_SUPABASE_ORIGIN } from "@/lib/go-bridge/constants";
import { GoScopeError } from "@/lib/go-bridge/scope";

export const GO_FETCH_TIMEOUT_MS = 8_000;

/** GO-only transport: user's JWT, fixed issuer, no redirects, deadline through body read. */
export function createTrustedGoFetch(publishableKey: string, userToken?: string): typeof fetch {
  return async (input, init) => {
    // Request applies native string/URL/Request + init semantics, including body and signal.
    const request = new Request(input, init);
    if (new URL(request.url).origin !== GO_SUPABASE_ORIGIN) {
      throw new GoScopeError("go_origin_invalid", "GO 请求地址不合法", 502);
    }
    request.signal.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.set("apikey", publishableKey);
    headers.set("cache-control", "no-store");
    if (userToken) headers.set("Authorization", `Bearer ${userToken}`);
    else if (publishableKey.startsWith("sb_") && headers.get("Authorization") === `Bearer ${publishableKey}`) {
      // Remove only the SDK's default key-as-Bearer, never auth.getUser(token)'s actual JWT.
      headers.delete("Authorization");
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("GO request timed out", "TimeoutError")), GO_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(request, {
        headers, redirect: "manual", cache: "no-store", signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new GoScopeError("go_redirect_blocked", "GO 返回了重定向，已阻断", 502);
      }
      const body = response.body === null ? null : await response.arrayBuffer();
      return new Response(body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  };
}
