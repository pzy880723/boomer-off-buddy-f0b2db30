// 测量任务个人忽略：会话员工身份、门店授权、任务归属、版本一致性、幂等重放。
// 核心逻辑在 measurement-dismissals.server.ts，DB 校验在 measurement_task_dismiss RPC。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMeasurementDismissal,
  dismissalInput,
  type DismissalRpc,
} from "./measurement-dismissals.server";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const STORE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK = "33333333-3333-4333-8333-333333333333";
const VER = "2026-10-18T18:38:20.794906Z";

const scopeA = { user_id: USER, location_ids: [STORE_A] };
const body = { location_id: STORE_A, task_id: TASK, request_version: VER };

function rpcReturning(result: { data?: unknown; error?: { message: string; code?: string } }): {
  rpc: DismissalRpc;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: result.data ?? null, error: result.error ?? null };
    },
  };
}

test("input schema: strict, user_id in body is rejected", () => {
  assert.equal(dismissalInput.safeParse(body).success, true);
  assert.equal(dismissalInput.safeParse({ ...body, user_id: OTHER_USER }).success, false);
  assert.equal(dismissalInput.safeParse({ ...body, location_id: "not-a-uuid" }).success, false);
  assert.equal(dismissalInput.safeParse({ ...body, request_version: "" }).success, false);
  assert.equal(dismissalInput.safeParse({ location_id: STORE_A, task_id: TASK }).success, false);
});

test("dismiss uses session user, never body user", async () => {
  const { rpc, calls } = rpcReturning({ data: { dismissed: true, task_id: TASK, request_version: VER } });
  const res = await applyMeasurementDismissal({ rpc }, scopeA, body, "dismiss");
  assert.equal(res.ok, true);
  assert.equal(calls[0].name, "measurement_task_dismiss");
  assert.equal(calls[0].args.p_user_id, USER);
  assert.equal("p_user_id" in calls[0].args && (calls[0].args.p_user_id as string) === OTHER_USER, false);
});

test("cross-store dismiss is forbidden before any DB write", async () => {
  const { rpc, calls } = rpcReturning({ data: null });
  const res = await applyMeasurementDismissal({ rpc }, scopeA, { ...body, location_id: STORE_B }, "dismiss");
  assert.deepEqual(res, { ok: false, status: 403, code: "location_forbidden", message: "Location not authorized for this account" });
  assert.equal(calls.length, 0);
});

test("DB task_location_mismatch maps to 403", async () => {
  const { rpc } = rpcReturning({ error: { message: "task_location_mismatch", code: "P0003" } });
  const res = await applyMeasurementDismissal({ rpc }, scopeA, body, "dismiss");
  assert.deepEqual(res, { ok: false, status: 403, code: "task_location_mismatch", message: "Task belongs to another store" });
});

test("completed/cancelled task maps to 409 task_closed", async () => {
  const { rpc } = rpcReturning({ error: { message: "task_closed", code: "P0009" } });
  const res = await applyMeasurementDismissal({ rpc }, scopeA, body, "dismiss");
  assert.deepEqual(res, { ok: false, status: 409, code: "task_closed", message: "Task already completed or cancelled" });
});

test("stale request_version maps to 409 with current_version", async () => {
  const { rpc } = rpcReturning({ error: { message: "stale_request_version:2026-10-19T01:02:03.000001Z", code: "P0010" } });
  const res = await applyMeasurementDismissal({ rpc }, scopeA, body, "dismiss");
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 409);
  assert.equal(res.code, "stale_request_version");
  assert.equal(res.current_version, "2026-10-19T01:02:03.000001Z");
});

test("unknown task maps to 404", async () => {
  const { rpc } = rpcReturning({ error: { message: "task_not_found", code: "P0002" } });
  const res = await applyMeasurementDismissal({ rpc }, scopeA, body, "dismiss");
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 404);
});

test("dismiss replay is idempotent (DB ON CONFLICT DO NOTHING)", async () => {
  const { rpc, calls } = rpcReturning({ data: { dismissed: true, task_id: TASK, request_version: VER } });
  const first = await applyMeasurementDismissal({ rpc }, scopeA, body, "dismiss");
  const second = await applyMeasurementDismissal({ rpc }, scopeA, body, "dismiss");
  assert.equal(first.ok && second.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, calls[1].args);
});

test("undismiss calls the undo RPC and is idempotent when absent", async () => {
  const { rpc, calls } = rpcReturning({ data: { dismissed: false, task_id: TASK, request_version: VER } });
  const res = await applyMeasurementDismissal({ rpc }, scopeA, body, "undismiss");
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.data.dismissed, false);
  assert.equal(calls[0].name, "measurement_task_undismiss");
});

test("unexpected DB error maps to 500 without leaking internals", async () => {
  const { rpc } = rpcReturning({ error: { message: "some low level detail with table names", code: "XX000" } });
  const res = await applyMeasurementDismissal({ rpc }, scopeA, body, "dismiss");
  assert.deepEqual(res, { ok: false, status: 500, code: "dismissal_failed", message: "Dismissal temporarily unavailable" });
});
