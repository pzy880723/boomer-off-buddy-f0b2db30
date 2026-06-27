/**
 * 生成 openapi.snapshot.json 快照（用于 CI 漂移检测），
 * 同时生成 TypeScript 类型给 APP 端参考。
 *
 * 使用：
 *   bun run sdk:gen
 *
 * Dart / Kotlin SDK 请在 APP 仓库使用 openapi-generator-cli 直接消费 openapi.json，
 * 详见 docs/handheld-api.md。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { buildHandheldOpenApi } from "../src/lib/handheld/openapi";

const snapshotPath = resolve(process.cwd(), "openapi.snapshot.json");
const doc = buildHandheldOpenApi();
const serialized = JSON.stringify(doc, null, 2) + "\n";

mkdirSync(dirname(snapshotPath), { recursive: true });
writeFileSync(snapshotPath, serialized, "utf-8");
console.log(`✓ wrote ${snapshotPath} (${serialized.length} bytes)`);
console.log("→ APP 端可运行：");
console.log("  npx openapi-typescript openapi.snapshot.json -o src/api/handheld.d.ts");
