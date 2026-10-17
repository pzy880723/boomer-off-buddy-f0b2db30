import { describe, expect, it } from "vitest";
import { alertFields } from "./handheld-alerts";

const base = { is_read: false, action_status: null, ref_type: null, ref_id: null, payload: {} };

describe("handheld alert fields", () => {
  it("unhandled unread order_paid alerts", () => {
    expect(alertFields({ ...base, kind: "order_paid", ref_type: "fulfillment", ref_id: "f1" }).should_alert).toBe(true);
  });
  it("measurement request alerts and exposes task id and sku id", () => {
    const r = alertFields({ ...base, kind: "measurement_requested", ref_type: "measurement_task", ref_id: "t1", payload: { sku_id: "s1" } });
    expect(r).toEqual({ should_alert: true, alert_kind: "measurement_requested", measurement_task_id: "t1", sku_id: "s1" });
  });
  it("handled, paused, voided or read do not alert", () => {
    for (const action_status of ["handled", "paused", "voided"]) {
      expect(alertFields({ ...base, kind: "measurement_requested", action_status }).should_alert).toBe(false);
    }
    expect(alertFields({ ...base, kind: "order_paid", is_read: true }).should_alert).toBe(false);
  });
  it("other kinds never alert", () => {
    expect(alertFields({ ...base, kind: "transfer_incoming" }).should_alert).toBe(false);
  });
});
