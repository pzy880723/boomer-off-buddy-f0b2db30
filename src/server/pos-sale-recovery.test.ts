import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let tables: Record<string, any[]>;
let rpcResult: { data: unknown; error: unknown };
let rpcCalls: Array<{ name: string; args: any }>;
const supabaseAdmin = {
  auth: { getUser: async () => ({ data: { user: { id: id(1), email: null } }, error: null }) },
  from(table: string) {
    let rows = tables[table] ?? [];
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        rows = rows.filter((row) => row[key] === value);
        return query;
      },
      in: (key: string, values: unknown[]) => {
        rows = rows.filter((row) => values.includes(row[key]));
        return query;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return query;
  },
  rpc: async (name: string, args: any) => {
    rpcCalls.push({ name, args });
    return rpcResult;
  },
};
(globalThis as any).__saleRecoveryTest = { supabaseAdmin };
const bundle = await build({
  entryPoints: ["src/routes/api/public/pos/sales.recover.cancel.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "sale-recovery-boundaries",
      setup(builder: any) {
        builder.onResolve(
          { filter: /^(@tanstack\/react-router|@\/integrations\/supabase\/client.server)$/ },
          (args: any) => ({ path: args.path, namespace: "stub" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "stub" }, (args: any) => ({
          contents:
            args.path === "@tanstack/react-router"
              ? "export const createFileRoute = () => options => options;"
              : "export const {supabaseAdmin} = globalThis.__saleRecoveryTest;",
        }));
      },
    },
  ],
});
const { Route } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
beforeEach(() => {
  tables = {
    user_roles: [{ user_id: id(1), role: "store_staff" }],
    user_location_perms: [{ user_id: id(1), location_id: id(2) }],
    inv_locations: [
      { id: id(2), name: "A", kind: "shop", is_active: true },
      { id: id(3), name: "B", kind: "shop", is_active: true },
    ],
    pos_shifts: [{ id: id(4), operator_id: id(1), location_id: id(2), status: "closed" }],
  };
  rpcCalls = [];
  rpcResult = {
    data: { status: "cancelled", client_op_id: "original-op", order: null },
    error: null,
  };
});
const submit = (
  body: object = { shift_id: id(4), client_op_id: "original-op" },
  token = "staff-token",
) =>
  Route.server.handlers.POST({
    request: new Request("https://erp.invalid/api/public/pos/sales/recover/cancel", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    }),
  });
test("closed original shift resolves using the authenticated employee, never a client operator", async () => {
  const result = await submit();
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, data: rpcResult.data });
  assert.deepEqual(rpcCalls, [
    {
      name: "pos_recover_sale_cancel",
      args: { p_shift_id: id(4), p_operator_id: id(1), p_client_op_id: "original-op" },
    },
  ]);
});
test("missing login, missing POS role, wrong employee and foreign store never invoke the recovery RPC", async () => {
  assert.equal((await submit(undefined, "")).status, 401);
  tables.user_roles = [];
  assert.equal((await submit()).status, 403);
  tables.user_roles = [{ user_id: id(1), role: "store_staff" }];
  tables.pos_shifts[0].operator_id = id(99);
  assert.equal((await submit()).status, 403);
  tables.pos_shifts[0].operator_id = id(1);
  tables.pos_shifts[0].location_id = id(3);
  assert.equal((await submit()).status, 403);
  assert.equal(rpcCalls.length, 0);
});
test("missing migration fails closed without a lookup-only fallback", async () => {
  for (const code of ["PGRST202", "42883", "42P01"]) {
    rpcResult = { data: null, error: { code, message: "not installed" } };
    const response = await submit();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "sale_recovery_unavailable");
  }
});
test("completed order is returned unchanged without attempting a refund or second sale", async () => {
  rpcResult.data = {
    status: "completed",
    client_op_id: "original-op",
    order: {
      order_id: id(10),
      order_no: "POS-10",
      subtotal: 10,
      discount_total: 1,
      total_amount: 9,
      points_redemption: { applied_points: 10 },
    },
  };
  assert.deepEqual(await (await submit()).json(), { ok: true, data: rpcResult.data });
  assert.equal(rpcCalls.length, 1);
});
test("malformed and mismatched recovery results never authorize clearing a local record", async () => {
  for (const data of [
    null,
    { status: "cancelled", client_op_id: "other-op", order: null },
    { status: "completed", client_op_id: "original-op", order: null },
    { status: "not_found" },
  ]) {
    rpcResult = { data, error: null };
    const response = await submit();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
  }
});
test("invalid requests and a missing shift fail without touching the RPC", async () => {
  assert.equal((await submit({ shift_id: id(4), client_op_id: "" })).status, 400);
  assert.equal(
    (await submit({ shift_id: id(4), client_op_id: "original-op", operator_id: id(99) })).status,
    400,
  );
  tables.pos_shifts = [];
  assert.equal((await submit()).status, 404);
  assert.equal(rpcCalls.length, 0);
});
test("idempotency collisions and backend failures do not produce a successful resolution", async () => {
  rpcResult = { data: null, error: { code: "P0001", message: "idempotency_conflict" } };
  const conflict = await submit();
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "idempotency_conflict");
  rpcResult = { data: null, error: { code: "57014", message: "statement timeout" } };
  assert.equal((await submit()).status, 503);
});
