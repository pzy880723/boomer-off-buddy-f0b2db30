import { test } from "node:test";
import assert from "node:assert/strict";
import { stampOperation, confirmBatch, retryBatch, BatchReceiptFence } from "./batch-confirmation.ts";

test("stamp nochange and empty selection do not clear; clear is explicit", () => {
  assert.equal(stampOperation("nochange"), null);
  assert.equal(stampOperation(""), null);
  assert.deepEqual(stampOperation("clear"), { kind: "stamp", value: null });
  assert.deepEqual(stampOperation("rare"), { kind: "stamp", value: "rare" });
});
test("confirmation copies items/op/version; retry uses only failed original versions", () => {
  const op = { kind: "notice" as const, add: ["parts_missing" as const], remove: [] };
  const items = [{ id: "a", expected_updated_at: "original" }, { id: "b", expected_updated_at: "old" }];
  const confirmed = confirmBatch("L1", op, items);
  items[0].expected_updated_at = "fresh";
  op.add.length = 0;
  assert.deepEqual(confirmed.op, { kind: "notice", add: ["parts_missing"], remove: [] });
  assert.deepEqual(retryBatch(confirmed, [{ id: "a", result: "failed", updated_at: "fresh" }, { id: "b", result: "success" }]).items,
    [{ id: "a", expected_updated_at: "original" }]);
});
test("context change, closed sheet and permission failure invalidate late receipts", () => {
  const fence = new BatchReceiptFence();
  const old = fence.begin("account1|L1|role|query");
  fence.invalidate();
  const current = fence.begin("account1|L2|role|query");
  assert.equal(fence.accept(old, "account1|L2|role|query"), false);
  assert.equal(fence.accept(current, "account1|L2|role|query"), true);
  fence.invalidate();
  assert.equal(fence.accept(current, "account1|L2|role|query"), false);
});