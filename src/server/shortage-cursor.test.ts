import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatShortageCursor, parseShortageCursor } from "./shortage-refund.server";

test("游标同时包含 created_at 与 id，同一时间戳的行不会被跳过", () => {
  const a = { created_at: "2026-09-15T01:00:00.000Z", id: "aaaa" };
  const cursor = formatShortageCursor(a);
  assert.deepEqual(parseShortageCursor(cursor), { createdAt: a.created_at, id: "aaaa" });
});

test("空或畸形游标视为无游标，不构造错误过滤条件", () => {
  assert.equal(parseShortageCursor(null), null);
  assert.equal(parseShortageCursor(""), null);
  assert.equal(parseShortageCursor("no-separator"), null);
  assert.equal(parseShortageCursor("|only-id"), null);
  assert.equal(parseShortageCursor("only-ts|"), null);
});
