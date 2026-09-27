import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = readFileSync(new URL("./deploy-listing-image-recovery-20260927.sh", import.meta.url), "utf8");
const start = script.match(/start_production\(\) \{[\s\S]*?\n\}/)[0];

for (const inherited of [undefined, "", "false", "true"]) {
  test(`new release leaves image flag unset without host configuration (inherited ${JSON.stringify(inherited)})`, () => {
    assert.equal(captureFlag("/new", inherited), "__UNSET__");
  });
}
test("rollback explicitly disables the old image worker", () => {
  assert.equal(captureFlag("/old", "true"), "false");
});

function captureFlag(target, inherited) {
  const dir = mkdtempSync(join(tmpdir(), "listing-deploy-env-"));
  try {
    const capture = join(dir, "flag");
    // Replace PM2 only: execute the real start function and env command locally.
    writeFileSync(join(dir, "pm2"), '#!/bin/bash\nprintf "%s" "${HANDHELD_LISTING_IMAGE_WORKER_ENABLED-__UNSET__}" > "$CAPTURE_FLAG"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CAPTURE_FLAG: capture };
    delete env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED;
    if (inherited !== undefined) env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED = inherited;
    const result = spawnSync("bash", ["-c", `set -euo pipefail\nold=/old\n${start}\nstart_production ${target}`], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(capture, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
