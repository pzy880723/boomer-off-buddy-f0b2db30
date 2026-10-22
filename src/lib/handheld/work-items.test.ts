// work-items 查询入参合同：include_ignored / ignored_only 为可选新参数，旧客户端不受影响。
import { test } from "node:test";
import assert from "node:assert/strict";
import { workItemsInput } from "./work-items";

test("legacy query without new params still parses with defaults", () => {
  const parsed = workItemsInput.safeParse({});
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.include_ignored, false);
    assert.equal(parsed.data.ignored_only, false);
  }
});

test("include_ignored and ignored_only accept only literal true", () => {
  const inc = workItemsInput.safeParse({ include_ignored: "true" });
  assert.equal(inc.success && inc.data.include_ignored, true);
  const only = workItemsInput.safeParse({ ignored_only: "true" });
  assert.equal(only.success && only.data.ignored_only, true);
  // "false"/"1"/空串 都不应被当成 true（z.coerce.boolean 的陷阱）
  const f = workItemsInput.safeParse({ include_ignored: "false" });
  assert.equal(f.success && f.data.include_ignored, false);
  const one = workItemsInput.safeParse({ include_ignored: "1" });
  assert.equal(one.success, false);
});

test("unknown params are rejected (strict)", () => {
  assert.equal(workItemsInput.safeParse({ user_id: "x" }).success, false);
});
