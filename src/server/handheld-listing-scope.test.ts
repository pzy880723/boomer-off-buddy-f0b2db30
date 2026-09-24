import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("src/routes/api/public/handheld/items.smart-create.ts", "utf8");

test("smart-create requires an employee session before any classification write or replay", () => {
  const guard = source.indexOf('if (!session) return err("Employee session required", 401');
  assert.ok(guard > 0, "missing employee session guard");
  assert.ok(guard < source.indexOf("await resolveOrCreateConfirmedIp("));
  assert.ok(guard < source.indexOf("await replayIfPresent("));
});

test("smart-create authorizes the exact inventory movement location before writing", () => {
  const guard = source.indexOf("await userCanAccessLocation(session.user_id, locationId)");
  assert.ok(guard > 0, "missing target location authorization");
  assert.ok(guard < source.indexOf("await resolveOrCreateConfirmedIp("));
  assert.ok(guard < source.indexOf("await replayIfPresent("));
  assert.match(source, /Location not accessible", 403/);
  assert.match(source, /p_location_id: locationId/);
  assert.match(source, /shopId: loc.shop_id/);
  assert.match(source, /p_release_shop_id: releaseShopId/);
  assert.doesNotMatch(source, /releaseSkuToOfflineShopsCore/);
});
