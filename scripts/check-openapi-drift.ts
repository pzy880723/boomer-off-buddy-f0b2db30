/**
 * CI 用：检测 OpenAPI 契约是否变更但未更新快照。
 * 如果当前从 schemas.ts 生成的 OpenAPI 文档 ≠ 仓库里的 openapi.snapshot.json，
 * 退出码 1，提示开发者运行 `bun run sdk:gen` 并通知 APP 端。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildHandheldOpenApi } from "../src/lib/handheld/openapi";

const snapshotPath = resolve(process.cwd(), "openapi.snapshot.json");
const current = JSON.stringify(buildHandheldOpenApi(), null, 2) + "\n";

if (!existsSync(snapshotPath)) {
  console.error("✗ openapi.snapshot.json 不存在。请先运行 `bun run sdk:gen` 提交快照。");
  process.exit(1);
}

const snapshot = readFileSync(snapshotPath, "utf-8");

if (snapshot === current) {
  console.log("✓ OpenAPI 契约与快照一致");
  process.exit(0);
}

console.error("✗ OpenAPI 契约已变更，但 openapi.snapshot.json 未更新。");
console.error("  请：");
console.error("    1. 运行 `bun run sdk:gen` 更新快照");
console.error("    2. 提交快照到 git");
console.error("    3. 通知 APP 端拉新版 openapi.json 重新生成 SDK");
process.exit(1);
