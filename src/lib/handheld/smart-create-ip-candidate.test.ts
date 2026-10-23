import test from "node:test";
import assert from "node:assert/strict";
import { SmartCreateReq } from "@/lib/handheld/schemas";
const base = { category: "toy", name: "屋", price_tier: 159 };
test("schema: ip_candidate optional; omitted stays absent", () => {
  assert.equal("ip_candidate" in SmartCreateReq.parse(base), false);
  assert.equal(SmartCreateReq.parse({ ...base, ip_candidate: " 陌生IP " }).ip_candidate, "陌生IP");
  assert.throws(() => SmartCreateReq.parse({ ...base, ip_candidate: "  " }));
  assert.throws(() => SmartCreateReq.parse({ ...base, ip_candidate: "x".repeat(121) }));
});
