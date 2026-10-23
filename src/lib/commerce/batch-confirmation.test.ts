import { test } from "node:test";
import assert from "node:assert/strict";
import { stampOperation, confirmBatch, retryBatch, BatchReceiptFence, batchPatchReturned, sameBatchVersion } from "./batch-confirmation.ts";

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

test("RETURNING must contain the exact target field values, not just a timestamp", () => {
  assert.equal(batchPatchReturned({ featured_stamp: "rare" }, { updated_at: "new", featured_stamp: "new" }), false);
  assert.equal(batchPatchReturned({ notice_tags: ["parts_missing"] }, { notice_tags: [] }), false);
  assert.equal(batchPatchReturned({ featured_stamp: null }, { featured_stamp: null, notice_tags: ["flawed"] }), true);
  assert.equal(batchPatchReturned({ fankuang_override: false }, { fankuang_override: false }), true);
});

test("exact versions distinguish 123456Z from 123999Z in the same millisecond", () => {
  assert.equal(sameBatchVersion("2026-10-23T04:07:00.123456Z", "2026-10-23T04:07:00.123999Z"), false);
});

test("versions normalize equivalent Z/+00:00 offsets and fractional precision without rounding", () => {
  assert.equal(sameBatchVersion("2026-10-23T04:07:00.123456Z", "2026-10-23T04:07:00.123456000+00:00"), true);
  assert.equal(sameBatchVersion("2026-10-23T04:07:00.123456789Z", "2026-10-23T12:07:00.123456789+08:00"), true);
  assert.equal(sameBatchVersion("2026-10-23T04:07:00.123456789Z", "2026-10-23T04:07:00.123456790Z"), false);
  assert.equal(sameBatchVersion("invalid", "invalid"), false);
});