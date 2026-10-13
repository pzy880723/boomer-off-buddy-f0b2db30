import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { listingAiTarget, listingAiFetch, LISTING_AI_DIRECT_URL, LISTING_AI_RELAY_FIXED_URL } from "./listing-ai-transport.server.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("no relay configured keeps legacy direct gateway with LOVABLE key", () => {
  assert.deepEqual(listingAiTarget("gw", {}), { url: LISTING_AI_DIRECT_URL, authorization: "Bearer gw", via: "direct" });
});
test("relay uses only the exact fixed URL and service-role bearer, never the gateway key", () => {
  const t = listingAiTarget("gw", { LISTING_AI_RELAY_URL: LISTING_AI_RELAY_FIXED_URL, SUPABASE_SERVICE_ROLE_KEY: "srk" });
  assert.deepEqual(t, { url: LISTING_AI_RELAY_FIXED_URL, authorization: "Bearer srk", via: "relay" });
});
test("any other relay URL or missing service-role key fails closed without direct fallback", () => {
  for (const url of [LISTING_AI_RELAY_FIXED_URL + "/", "http://boomer-off-buddy.lovable.app/api/public/hooks/listing-ai-relay",
    "https://evil.test/api/public/hooks/listing-ai-relay", LISTING_AI_RELAY_FIXED_URL + "?x=1"])
    assert.throws(() => listingAiTarget("gw", { LISTING_AI_RELAY_URL: url, SUPABASE_SERVICE_ROLE_KEY: "srk" }), /permanent: LISTING_AI_RELAY_URL not allowed/);
  assert.throws(() => listingAiTarget("gw", { LISTING_AI_RELAY_URL: LISTING_AI_RELAY_FIXED_URL }), /permanent: relay auth unavailable/);
});
test("listingAiFetch posts body unchanged to the relay with service-role bearer", async () => {
  let seen: any;
  globalThis.fetch = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response("{}"); }) as any;
  await listingAiFetch('{"model":"m"}', "gw", undefined, { "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    { LISTING_AI_RELAY_URL: LISTING_AI_RELAY_FIXED_URL, SUPABASE_SERVICE_ROLE_KEY: "srk" });
  assert.equal(seen.url, LISTING_AI_RELAY_FIXED_URL);
  assert.equal(seen.init.headers.Authorization, "Bearer srk");
  assert.equal(seen.init.body, '{"model":"m"}');
  assert.equal(seen.init.redirect, "error");
});
