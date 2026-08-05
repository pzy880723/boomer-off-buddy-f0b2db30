import assert from "node:assert/strict";
import test from "node:test";

import { deliverStoredOtp } from "./otp-delivery.server";

test("failed SMS delivery removes the unusable OTP record", async () => {
  let removed = 0;

  const result = await deliverStoredOtp({
    send: async () => ({
      ok: false,
      code: "sms_not_configured",
      message: "短信服务未配置",
    }),
    removeStoredOtp: async () => {
      removed += 1;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(removed, 1);
});

test("successful SMS delivery keeps the OTP record", async () => {
  let removed = 0;

  const result = await deliverStoredOtp({
    send: async () => ({ ok: true, serial: "serial-1" }),
    removeStoredOtp: async () => {
      removed += 1;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(removed, 0);
});
