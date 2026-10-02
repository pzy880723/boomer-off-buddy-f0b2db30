import assert from "node:assert/strict";
import { test } from "node:test";
import { collectPosAvailablePage } from "./available-page";

test("reserved goods do not fill the visible page and cursor skips only consumed rows", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ id: String(i) }));
  const result = await collectPosAvailablePage(
    0,
    async (offset, size) => rows.slice(offset, offset + size),
    async (r) => (Number(r.id) < 30 ? 0 : 1),
  );
  assert.equal(result.items.length, 24);
  assert.equal(result.items[0].row.id, "30");
  assert.equal(result.next_offset, 54);
  const next = await collectPosAvailablePage(
    result.next_offset!,
    async (offset, size) => rows.slice(offset, offset + size),
    async () => 1,
  );
  assert.deepEqual(
    next.items.map((i) => i.row.id),
    ["54", "55", "56", "57", "58", "59"],
  );
  assert.equal(next.next_offset, null);
});
test("stock failures fail closed instead of showing sellable products", async () => {
  await assert.rejects(
    collectPosAvailablePage(
      0,
      async () => [{ id: "a" }],
      async () => {
        throw new Error("stock unavailable");
      },
    ),
    /stock unavailable/,
  );
});
test("empty scoped query does not inspect or sign other-store goods", async () => {
  const result = await collectPosAvailablePage(
    0,
    async () => [],
    async () => {
      throw new Error("must not run");
    },
  );
  assert.deepEqual(result, { items: [], next_offset: null });
});
