#!/usr/bin/env node
// Start-up gate for the App Store demo instance. Prints violation names only (never values).
import { isReviewIsolated, reviewIsolationViolations } from "../src/server/review-isolation.mjs";

if (isReviewIsolated()) {
  const v = reviewIsolationViolations();
  if (v.length) {
    console.error(`[review-isolation] refusing to start demo instance: ${v.join(", ")}`);
    process.exit(1);
  }
  console.log("[review-isolation] demo instance configuration OK (environment=demo)");
}
