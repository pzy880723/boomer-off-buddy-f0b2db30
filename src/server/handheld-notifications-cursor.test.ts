import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChangeCursor, parseListCursor } from "./handheld-notifications-cursor";

test("parses v2 change cursor and latest", () => {
  assert.equal(parseChangeCursor("latest"), "latest");
  assert.deepEqual(parseChangeCursor("v2:812:44"), { xid: "812", seq: 44 });
  for (const bad of ["v2:x:1", "v1:1:1", "v2:1", "2026-01-01T00:00:00Z", "v2:1:1;drop"]) assert.equal(parseChangeCursor(bad), null);
});
test("parses composite list cursor; legacy ts stays legacy", () => {
  assert.deepEqual(parseListCursor("2026-01-01T00:00:00.000Z|00000000-0000-0000-0000-0000000000a1"), {
    ts: "2026-01-01T00:00:00.000Z", id: "00000000-0000-0000-0000-0000000000a1" });
  assert.equal(parseListCursor("2026-01-01T00:00:00.000Z"), null);
  assert.equal(parseListCursor("2026-01-01T00:00:00Z|x),or(id.gt.0"), null);
});
