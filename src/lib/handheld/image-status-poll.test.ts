import assert from "node:assert/strict";
import { test } from "node:test";
import { ImageProcessingStatusSchema, imageProcessingShouldPoll } from "./schemas";
test("terminal and unknown statuses stop polling; pending ones poll", () => {
  for (const s of ["failed", "partial_failed_terminal", "succeeded", "idle", "partial_failed", "future_x", null, 5]) assert.equal(imageProcessingShouldPoll(s), false);
  for (const s of ["queued", "processing", "retryable_failed"]) assert.equal(imageProcessingShouldPoll(s), true);
});
test("new terminal values are valid DTO strings", () => {
  for (const s of ["failed", "partial_failed_terminal"]) assert.equal(ImageProcessingStatusSchema.parse(s), s);
});
