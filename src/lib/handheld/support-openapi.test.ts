import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHandheldOpenApi } from "./openapi";

test("support contract documents assignment actions and server-filtered queues", () => {
  const document = buildHandheldOpenApi();
  const assignment = document.paths?.["/api/public/handheld/support/conversations/{id}/assignment"]?.post;
  assert.ok(assignment?.requestBody);
  const queues = document.paths?.["/api/public/handheld/support/conversations"]?.get?.parameters;
  assert.ok(queues?.some((parameter) => "name" in parameter && parameter.name === "queue"));
});

test("support mobile contract: list q / detail paging / is_mine / optional location_id", () => {
  const document = buildHandheldOpenApi();
  const json = JSON.stringify(document);
  const list = document.paths?.["/api/public/handheld/support/conversations"]?.get;
  const q = list?.parameters?.find((p) => "name" in p && p.name === "q") as { schema?: { maxLength?: number } } | undefined;
  assert.equal(q?.schema?.maxLength, 80);
  assert.match(String(list?.description), /last_customer_message_at/);

  const detail = document.paths?.["/api/public/handheld/support/conversations/{id}"];
  const names = (detail?.get?.parameters ?? []).map((p) => ("name" in p ? p.name : ""));
  for (const n of ["location_id", "limit", "before", "after"]) assert.ok(names.includes(n), n);
  const limit = detail?.get?.parameters?.find((p) => "name" in p && p.name === "limit") as { schema?: { minimum?: number; maximum?: number }; description?: string };
  assert.equal(limit.schema?.minimum, 1);
  assert.equal(limit.schema?.maximum, 100);
  assert.match(String(limit.description), /500/);
  const desc = String(detail?.get?.description);
  for (const k of ["cursor_conflict", "older_cursor", "latest_cursor", "has_newer", "is_mine", "location_mismatch"]) assert.match(desc, new RegExp(k));
  assert.match(String(detail?.post?.description), /location_id\?/);
  assert.match(json, /location_mismatch，写入前拒绝/);
});
