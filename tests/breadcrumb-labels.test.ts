import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ROOT_ROUTE = join(ROOT, "src/routes/__root.tsx");

/**
 * 面包屑标签只写在 src/routes/__root.tsx 的 breadcrumbMap 里。
 * 该文件带 `../styles.css?url` 这类 Vite 专用导入，测试无法直接 import，
 * 所以这里按源码契约核对：地图里必须显式给出这两个新页面的中文段名，
 * 否则页面顶部会退回显示英文代码。
 */
function readBreadcrumbMap(): Record<string, string> {
  const src = readFileSync(ROOT_ROUTE, "utf8");
  const start = src.indexOf("const breadcrumbMap: Record<string, string> = {");
  assert.ok(start >= 0, "breadcrumbMap not found in src/routes/__root.tsx");
  const end = src.indexOf("};", start);
  assert.ok(end > start, "breadcrumbMap block is not terminated");
  const block = src.slice(start, end);
  const labels: Record<string, string> = {};
  for (const [, key, value] of block.matchAll(/^\s*"([^"]+)"\s*:\s*"([^"]+)",$/gm)) {
    labels[key] = value;
  }
  for (const [, key, value] of block.matchAll(/^\s*([A-Za-z][\w-]*)\s*:\s*"([^"]+)",$/gm)) {
    labels[key] = value;
  }
  return labels;
}

test("measurements page shows a Chinese breadcrumb label", () => {
  const labels = readBreadcrumbMap();
  assert.equal(labels.measurements, "尺寸待办");
});

test("readiness page shows a Chinese breadcrumb label", () => {
  const labels = readBreadcrumbMap();
  assert.equal(labels.readiness, "上架准备");
});

test("channel-sync page shows a Chinese breadcrumb label", () => {
  const labels = readBreadcrumbMap();
  assert.equal(labels["channel-sync"], "渠道同步");
});

test("api-integration page shows a Chinese breadcrumb label", () => {
  const labels = readBreadcrumbMap();
  assert.equal(labels["api-integration"], "接口管理");
});

test("both labelled segments are backed by real inventory routes", () => {
  assert.ok(existsSync(join(ROOT, "src/routes/inventory.measurements.tsx")));
  assert.ok(existsSync(join(ROOT, "src/routes/inventory.readiness.tsx")));
});

test("the two new labelled segments are backed by real admin routes", () => {
  assert.ok(existsSync(join(ROOT, "src/routes/admin.channel-sync.tsx")));
  assert.ok(existsSync(join(ROOT, "src/routes/admin.api-integration.tsx")));
});
