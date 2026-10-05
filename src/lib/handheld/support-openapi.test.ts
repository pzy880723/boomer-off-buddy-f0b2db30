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
