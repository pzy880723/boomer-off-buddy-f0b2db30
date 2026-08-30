import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const authHelper = readFileSync(new URL("./handheld-auth.server.ts", import.meta.url), "utf8");
const authMeRoute = readFileSync(
  new URL("../routes/api/public/handheld/auth.me.ts", import.meta.url),
  "utf8",
);

describe("handheld session recovery contract", () => {
  test("prefers the bearer access token over a stale X-Session-Token", () => {
    const authorizationIndex = authHelper.indexOf("authorization ||");
    const legacyHeaderIndex = authHelper.indexOf('request.headers.get("x-session-token") ||');

    assert.notEqual(authorizationIndex, -1);
    assert.notEqual(legacyHeaderIndex, -1);
    assert.ok(authorizationIndex < legacyHeaderIndex);
  });

  test("auth/me rejects an explicitly supplied invalid session as JSON 401", () => {
    assert.match(authMeRoute, /hasSessionCredential/);
    assert.match(authMeRoute, /return err\("Invalid session token", 401, \{ code: "unauthorized" \}\)/);
  });
});
