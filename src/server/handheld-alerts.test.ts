import { test } from "node:test";
import assert from "node:assert/strict";
import { alertFields } from "./handheld-alerts";

const base = { is_read: false, action_status: null, ref_type: null, ref_id: null, payload: {} };

test("unhandled unread order_paid alerts", () => {
  assert.equal(alertFields({ ...base, kind: "order_paid", ref_type: "fulfillment", ref_id: "f1" }).should_alert, true);
});
test("measurement request alerts and exposes task id and sku id", () => {
  const r = alertFields({ ...base, kind: "measurement_requested", ref_type: "measurement_task", ref_id: "t1", payload: { sku_id: "s1" } });
  assert.deepEqual(r, { should_alert: true, alert_kind: "measurement_requested", measurement_task_id: "t1", sku_id: "s1" });
});
test("handled, paused, voided or read do not alert", () => {
  for (const action_status of ["handled", "paused", "voided"]) {
    assert.equal(alertFields({ ...base, kind: "measurement_requested", action_status }).should_alert, false);
  }
  assert.equal(alertFields({ ...base, kind: "order_paid", is_read: true }).should_alert, false);
});
test("other kinds never alert", () => {
  assert.equal(alertFields({ ...base, kind: "transfer_incoming" }).should_alert, false);
});

test("exact contract: only action_status === null alerts; empty string and paused do not", () => {
  const row = { ...base, kind: "measurement_requested", ref_type: "measurement_task", ref_id: "t1" };
  assert.equal(alertFields({ ...row, action_status: null }).should_alert, true);
  assert.equal(alertFields({ ...row, action_status: "" }).should_alert, false);
  assert.equal(alertFields({ ...row, action_status: "paused" }).should_alert, false);
  assert.equal(alertFields({ ...row, action_status: null, is_read: true }).should_alert, false);
});
