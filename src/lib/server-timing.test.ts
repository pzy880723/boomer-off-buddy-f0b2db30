import test from "node:test";
import assert from "node:assert/strict";
import { createServerTiming } from "./server-timing";

test("按阶段输出 Server-Timing 并附 total", () => {
  let t = 0;
  const timer = createServerTiming(() => t);
  t = 5; timer.mark("auth");
  t = 25; timer.mark("validate");
  assert.equal(timer.header(), "auth;dur=5.0, validate;dur=20.0, total;dur=25.0");
});

test("apply 给响应加头", () => {
  const timer = createServerTiming(() => 0);
  const res = timer.apply(Response.json({ ok: true }));
  assert.match(res.headers.get("Server-Timing") ?? "", /total;dur=0.0/);
});
