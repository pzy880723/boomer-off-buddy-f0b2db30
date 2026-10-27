import { test } from "node:test";
import assert from "node:assert/strict";
import { recordValidatedRetouch } from "./retouch-receipt.server.ts";
test("preserved_original never issues validated_retouch", async () => {
  let calls = 0;
  await recordValidatedRetouch({ preserved_original: true }, async () => { calls++; return { error: null }; });
  assert.equal(calls, 0);
});
test("validated output requires durable receipt", async () => {
  let calls = 0;
  await recordValidatedRetouch({}, async () => { calls++; return { error: null }; });
  assert.equal(calls, 1);
  await assert.rejects(recordValidatedRetouch({}, async () => ({ error: new Error() })), /retouch_receipt_unavailable/);
});