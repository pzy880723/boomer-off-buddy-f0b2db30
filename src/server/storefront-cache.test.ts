import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { storefrontPrivateJson } from "@/server/storefront-auth.server";

describe("storefrontPrivateJson", () => {
  test("sets Cache-Control: private, no-store on order responses", async () => {
    const res = storefrontPrivateJson({ ok: true, data: { pickups: [] } });
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("Content-Type"), "application/json");
    assert.deepEqual(await res.json(), { ok: true, data: { pickups: [] } });
  });

  test("keeps explicit status and cannot be overridden to a cacheable value", () => {
    const res = storefrontPrivateJson({ ok: true }, { status: 201 });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  });
});
