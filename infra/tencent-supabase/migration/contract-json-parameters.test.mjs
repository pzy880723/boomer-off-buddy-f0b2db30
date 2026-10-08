import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { prepareValue } = require("pg/lib/utils.js");
const source = await readFile(new URL("./migrate-boomer-open.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("migration.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let parameters;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "client.query" &&
      node.arguments[0]?.getText(ast).includes("insert into public.store_development_contract_analyses")) {
    parameters = node.arguments[1].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(parameters, "find actual contract INSERT parameters");
const bind = new Function("analysis", "projectId", "attachmentId", "attachment", "dateOnly", `return ${parameters}`);

for (const values of [[], ["租金含税", "引号\"与换行\n", { risk: "押金" }]]) {
  test(`contract JSON arrays survive node-postgres binding (${values.length} entries)`, () => {
    const analysis = { keyTerms: values, riskFlags: values };
    const bound = bind(analysis, "project", "attachment", { legacyId: "file" }, value => value?.slice(0, 10) ?? null);
    assert.deepEqual(JSON.parse(prepareValue(bound[11])), values);
    assert.deepEqual(JSON.parse(prepareValue(bound[12])), values);
    assert.deepEqual(JSON.parse(prepareValue(bound[15])), analysis);
  });
}

test("missing contract arrays bind as JSON arrays, not PostgreSQL array syntax", () => {
  const bound = bind({}, "project", "attachment", { legacyId: "file" }, () => null);
  assert.equal(prepareValue(bound[11]), "[]");
  assert.equal(prepareValue(bound[12]), "[]");
});
