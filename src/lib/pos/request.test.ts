import assert from "node:assert/strict";
import { test } from "node:test";
import { posRequest, isConfirmedSale } from "./request";

test("malformed envelopes preserve unknown payment status", async (t) => {
  for (const body of [{}, null, { ok: false }, { ok: true }, { ok: "false" }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(body));
    const result = await posRequest("/sales", "test");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "result_unknown");
    t.mock.restoreAll();
  }
});

test("only a confirmed order may clear a sale recovery record", async (t) => {
  for (const data of [null, {}, { order_id: "" }, { order_id: "order", total_amount: -1 }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, data }));
    const result = await posRequest("/sales", "test", undefined, isConfirmedSale);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "result_unknown");
    t.mock.restoreAll();
  }
  const data = { order_id: "42e1195a-0695-4a57-90ae-2d9f468358fb", order_no: "POS-1", total_amount: 12.9 };
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, data }));
  assert.deepEqual(await posRequest("/sales", "test", undefined, isConfirmedSale), { ok: true, data });
});

test("explicit rejection stays definite but server errors and HTML stay unknown", async (t) => {
  const rejection = { ok: false, message: "库存不足", code: "sale_conflict" };
  t.mock.method(globalThis, "fetch", async () => Response.json(rejection, { status: 409 }));
  assert.deepEqual(await posRequest("/sales", "test"), rejection);
  t.mock.restoreAll();
  for (const response of [Response.json(rejection, { status: 500 }), new Response("Bad Gateway", { status: 502 }), Response.json({ ok: true, data: {} }, { status: 400 })]) {
    t.mock.method(globalThis, "fetch", async () => response);
    const result = await posRequest("/sales", "test");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "result_unknown");
    t.mock.restoreAll();
  }
});
