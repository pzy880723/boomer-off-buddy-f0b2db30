import { createHash } from "node:crypto";

const origin = "https://migration-data.boomeroff.top";
type Manifest = { version: number; generatedAt: number; entries: Record<string, { digest: string }> };

// Only published catalog callers may use this mapping; it is not an arbitrary-source proxy.
export function tencentDerivative(value: string, width: number, manifest: Manifest | null): string | null {
  if (!manifest || ![640, 1280].includes(width) || typeof value !== "string" || /[\\\u0000-\u001f]|\.\.|%2e|%2f|%5c|%00/i.test(value)) return null;
  try {
    let key = value;
    if (value.startsWith("https://")) {
      const url = new URL(value);
      if (url.origin !== "https://sxddfcoiaboqcmeviykl.supabase.co" || url.username || url.password) return null;
      const match = /^\/storage\/v1\/object\/(?:sign|public)\/(.+)$/.exec(url.pathname);
      if (!match) return null;
      key = match[1];
    }
    const parts = key.split("/").map(decodeURIComponent);
    if (!parts.every(p => p && p !== "." && !/[\\/\u0000-\u001f]/.test(p)) || !["sku-listing", "sku-raw", "parcel-item-images", "shop-images"].includes(parts[0]) || parts.length < 2) return null;
    const id = createHash("sha256").update(parts.join("/")).digest("hex");
    const digest = manifest.entries[id]?.digest;
    return digest && /^[a-f0-9]{64}$/.test(digest) ? `https://erp.boomeroff.com/api/public/storefront/media/v1/${digest}/${width}.jpg` : null;
  } catch { return null; }
}

export function createManifestReader(fetcher: typeof fetch = fetch, now = Date.now) {
  let cached: Manifest | null = null;
  let until = 0;
  let pending: Promise<Manifest | null> | null = null;
  return async (): Promise<Manifest | null> => {
    if (cached && cached.generatedAt < now() - 86400000) cached = null;
    if (now() < until) return cached;
    if (!pending) pending = (async () => {
      try {
        const response = await fetcher(`${origin}/storefront-media/manifest.json`, { redirect: "error", signal: AbortSignal.timeout(2000) });
        if (!response.ok || Number(response.headers.get("content-length")) > 2_000_000) return cached;
        const raw = await response.text(); if (raw.length > 2_000_000) return cached;
        const data = JSON.parse(raw);
        if (data.version === 1 && Number.isFinite(data.generatedAt) && data.generatedAt <= now() && data.generatedAt > now() - 86400000 && data.entries && typeof data.entries === "object" && !Array.isArray(data.entries)) cached = data;
      } catch { /* Missing Tencent media keeps the legacy derivative fallback, never originals. */ }
      finally { until = now() + 60000; pending = null; }
      return cached;
    })();
    return cached || pending;
  };
}
export const loadTencentMediaManifest = createManifestReader();
