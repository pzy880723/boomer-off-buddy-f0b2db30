import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync("src/lib/omnichannel-ops.functions.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function harness(rows: Array<Record<string, unknown>>, skus: Array<Record<string, unknown>> = [], metadataError = false, authenticated = true) {
  const calls: Array<unknown[]> = [];
  const auth = Symbol("existing-auth");
  const client = {
    from(table: string) {
      calls.push(["from", table]);
      const query = {
        select(columns: string) { calls.push(["select", table, columns]); return query; },
        order(column: string, options: unknown) { calls.push(["order", table, column, options]); return query; },
        limit(limit: number) { calls.push(["limit", table, limit]); return query; },
        eq(column: string, value: unknown) { calls.push(["eq", table, column, value]); return query; },
        in(column: string, values: unknown[]) { calls.push(["in", table, column, [...values]]); return query; },
        then(resolve: (result: unknown) => unknown) {
          return Promise.resolve(resolve(table === "inventory_sale_events"
            ? { data: rows, error: null }
            : { data: skus, error: metadataError ? { message: "private_internal_failure" } : null }));
        },
      };
      return query;
    },
  };
  const exports: Record<string, (input: { data: unknown }) => Promise<any>> = {};
  runInNewContext(compiled, {
    exports,
    require(name: string) {
      if (name === "zod") return { z: {} }; // Validators are captured, never bypassed in production.
      if (name.endsWith("client.server")) return { supabaseAdmin: client };
      if (name.endsWith("auth-middleware")) return { requireSupabaseAuth: auth };
      if (name === "@tanstack/react-start") return {
        createServerFn() {
          let middleware: unknown[] = [];
          const builder = {
            middleware(value: unknown[]) { middleware = value; return builder; },
            inputValidator(_validator: unknown) { return builder; },
            handler(handler: (input: unknown) => Promise<unknown>) {
              return async (input: unknown) => {
                assert.equal(middleware.length, 1);
                assert.equal(middleware[0], auth);
                if (!authenticated) throw new Error("员工未登录");
                return handler(input);
              };
            },
          };
          return builder;
        },
      };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return { read: exports.listSaleEvents, calls };
}

test("getter批量读取返回行的去重SKU，保留事件、订单、过滤和范围，只执行SELECT", async () => {
  const rows = [
    { id: "e1", sku_id: "s1", source_order_id: "REAL-ORDER-1" },
    { id: "e2", sku_id: "s1", source_order_id: "REAL-ORDER-2" },
    { id: "e3", sku_id: "s2" },
    { id: "e4", sku_id: null },
  ];
  const sku = { id: "s1", name: "真实品牌瓷杯", sku_code: "C1" };
  const h = harness(rows, [sku]);
  const result = await h.read({ data: { status: "processed", limit: 37 } });
  assert.equal(result.items.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), rows.map(r => ({ ...r, sku: r.sku_id === "s1" ? sku : null })));
  assert.deepEqual(h.calls.filter(c => c[0] === "from"), [["from", "inventory_sale_events"], ["from", "inv_skus"]]);
  assert.deepEqual(h.calls.find(c => c[0] === "in"), ["in", "inv_skus", "id", ["s1", "s2"]]);
  assert.deepEqual(h.calls.find(c => c[0] === "select" && c[1] === "inv_skus"), ["select", "inv_skus", "id, name, sku_code"]);
  assert.deepEqual(h.calls.find(c => c[0] === "eq"), ["eq", "inventory_sale_events", "status", "processed"]);
  assert.deepEqual(h.calls.find(c => c[0] === "limit"), ["limit", "inventory_sale_events", 37]);
  assert.equal(h.calls.find(c => c[0] === "order")?.[2], "received_at");
});

test("SKU读取错误拒绝返回伪成功，错误为中文且不泄露内部信息", async () => {
  const h = harness([{ id: "e1", sku_id: "s1" }], [], true);
  await assert.rejects(h.read({ data: { status: "all", limit: 100 } }), /商品信息读取失败，请稍后重试/);
});

test("空事件或无SKU不查商品，all不加状态过滤", async () => {
  for (const rows of [[], [{ id: "e1", sku_id: null }]]) {
    const h = harness(rows);
    const result = await h.read({ data: { status: "all", limit: 100 } });
    assert.equal(result.items.length, rows.length);
    assert.equal(h.calls.some(c => c[1] === "inv_skus"), false);
    assert.equal(h.calls.some(c => c[0] === "eq"), false);
  }
});

test("原鉴权middleware注册合同不变，模拟拒绝时不读取（不宣称真实会话验收）", async () => {
  const h = harness([], [], false, false);
  await assert.rejects(h.read({ data: { status: "all", limit: 100 } }), /员工未登录/);
  assert.deepEqual(h.calls, []);
});