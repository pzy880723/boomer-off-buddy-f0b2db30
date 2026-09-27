import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../src/lib/youzan-offline-products.functions.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("release.ts", source, ts.ScriptTarget.Latest, true);
let existingBranch;
function visit(node) {
  if (ts.isIfStatement(node) && node.expression.getText(ast) === "remoteExisting") existingBranch = node;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(existingBranch);
// Execute the actual orchestration branch with network/database boundaries replaced.
const code = ts.transpileModule(`async function run(d) {
 const { remoteExisting, verifyBranch, upsertBranchLink, enqueueBranchStock } = d;
 const args={sku_id:"sku",stock_override:undefined}, branch={id:"branch"}, hq={kdt_id:1},
 hqLink={yz_item_id:100,spu_code:"HQ"}, sku={price_tier:399}, location={id:"loc"},
 isCustom=true, hqChannel={itemId:9}, accessToken="test", releaseInput={}, stock=1, results=[];
 const updateYouzanOfflineProduct=async()=>{}, updateCustomHqPrice=async()=>{}, isYouzanProductNotFoundError=()=>false;
 for (const unused of [1]) { ${existingBranch.getText(ast)} }
 return results;
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const run = new Function(`${code};return run;`)();

test("release persists verified post-update channel IDs, not the stale pre-update identity", async () => {
  const links = [], queued = [];
  const results = await run({
    remoteExisting: { itemId: 6451683371, skus: [{ skuId: 6451683371 }] },
    verifyBranch: async () => ({ itemId: 6451875067, skus: [{ skuId: 15114101704 }] }),
    upsertBranchLink: async row => links.push(row), enqueueBranchStock: async row => queued.push(row),
  });
  assert.equal(links[0].itemId, 6451875067);
  assert.equal(links[0].skuIdRemote, 15114101704);
  assert.equal(results[0].item_id, 6451875067);
  assert.equal(results[0].sku_id, 15114101704);
  assert.equal(queued[0].targetStock, 1);
  assert.equal(queued[0].locationId, "loc");
});

test("failed verification never persists identity or enqueues stock", async () => {
  await assert.rejects(run({ remoteExisting: { itemId: 5, skus: [{ skuId: 6 }] },
    verifyBranch: async () => { throw Error("barcode mismatch"); },
    upsertBranchLink: async () => assert.fail("must not persist"),
    enqueueBranchStock: async () => assert.fail("must not enqueue"),
  }), /barcode mismatch/);
});
