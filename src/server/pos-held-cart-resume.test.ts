import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let tables: Record<string, any[]>;
let updateError: { message: string } | null;
let updates: number;
let claims: number;
let race: boolean;
let reads: number;
let bothRead: Promise<void>;
let releaseReads: () => void;
const supabaseAdmin = {
  auth: { getUser: async () => ({ data: { user: { id: id(1), email: null } }, error: null }) },
  from(table: string) {
    const filters: Array<(row: any) => boolean> = [];
    let patch: Record<string, unknown> | undefined;
    let selected: string | undefined;
    const execute = async (single: boolean) => {
      const rows = (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
      if (patch) {
        updates += 1;
        if (updateError) return { data: null, error: updateError };
        // Evaluate the status predicate at update time, like the atomic SQL UPDATE.
        for (const row of rows) Object.assign(row, patch);
        claims += rows.length;
        const data = selected === "id" ? rows.map((row) => ({ id: row.id })) : null;
        return { data: single ? (data?.[0] ?? null) : data, error: null };
      }
      const data = structuredClone(single ? (rows[0] ?? null) : rows);
      if (table === "pos_held_carts" && race) {
        reads += 1;
        if (reads === 2) releaseReads();
        await bothRead;
      }
      return { data, error: null };
    };
    const query = {
      select: (columns: string) => {
        selected = columns;
        return query;
      },
      update: (value: Record<string, unknown>) => {
        patch = value;
        return query;
      },
      eq: (key: string, value: unknown) => {
        filters.push((row) => row[key] === value);
        return query;
      },
      in: (key: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[key]));
        return query;
      },
      maybeSingle: () => execute(true),
      then: (resolve: (value: unknown) => unknown) => execute(false).then(resolve),
    };
    return query;
  },
};
(globalThis as any).__heldCartResumeTest = { supabaseAdmin };
const bundle = await build({
  entryPoints: ["src/routes/api/public/pos/carts.$id.resume.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "held-cart-resume-boundaries",
      setup(builder: any) {
        builder.onResolve(
          { filter: /^(@tanstack\/react-router|@\/integrations\/supabase\/client.server)$/ },
          (args: any) => ({ path: args.path, namespace: "stub" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "stub" }, (args: any) => ({
          contents:
            args.path === "@tanstack/react-router"
              ? "export const createFileRoute = () => options => options;"
              : "export const {supabaseAdmin} = globalThis.__heldCartResumeTest;",
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
    inv_locations: [{ id: id(2), name: "A", kind: "shop", is_active: true }],
    pos_held_carts: [
      {
        id: id(4),
        location_id: id(2),
        status: "held",
        customer_id: id(5),
        note: "test cart",
        discount_snapshot: { discount_total: 1 },
        benefit_snapshot: { tier: "free" },
        pos_held_cart_items: [{ id: id(6), sku_id: id(7), quantity: 2, price_snapshot: 10 }],
      },
    ],
  };
  updateError = null;
  updates = 0;
  claims = 0;
  race = false;
  reads = 0;
  bothRead = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
});
const submit = (token = "staff-token") =>
  Route.server.handlers.POST({
    request: new Request(`https://erp.invalid/api/public/pos/carts/${id(4)}/resume`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    params: { id: id(4) },
  });

test("two terminals reading held concurrently allow only the successful claimant to resume", async () => {
  race = true;
  const snapshot = structuredClone(tables.pos_held_carts[0]);
  const responses: Response[] = await Promise.all([submit(), submit()]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const winner = responses.find((r) => r.status === 200)!;
  const loser = responses.find((r) => r.status === 409)!;
  assert.deepEqual(await winner.json(), { ok: true, data: snapshot });
  assert.deepEqual(await loser.json(), {
    ok: false,
    message: "挂单已经处理",
    code: "cart_not_held",
  });
  assert.equal(reads, 2);
  assert.equal(updates, 2);
  assert.equal(claims, 1);
});
test("one claimant receives the original full snapshot and a retry is rejected", async () => {
  const snapshot = structuredClone(tables.pos_held_carts[0]);
  const response = await submit();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, data: snapshot });
  assert.equal(tables.pos_held_carts[0].status, "resumed");
  assert.ok(Number.isFinite(Date.parse(tables.pos_held_carts[0].resumed_at)));
  const retry = await submit();
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).code, "cart_not_held");
  assert.equal(updates, 1);
});
test("database update errors return 500 without exposing a successful cart snapshot", async () => {
  updateError = { message: "write failed" };
  const response = await submit();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, message: "write failed" });
  assert.equal(claims, 0);
});
test("missing login, missing POS role and another store cannot claim the cart", async () => {
  assert.equal((await submit("")).status, 401);
  tables.user_roles = [];
  assert.equal((await submit()).status, 403);
  tables.user_roles = [{ user_id: id(1), role: "store_staff" }];
  tables.pos_held_carts[0].location_id = id(99);
  const response = await submit();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "location_forbidden");
  assert.equal(updates, 0);
});
test("missing or already processed carts never attempt the update", async () => {
  tables.pos_held_carts[0].status = "cancelled";
  assert.equal((await submit()).status, 409);
  tables.pos_held_carts = [];
  assert.equal((await submit()).status, 404);
  assert.equal(updates, 0);
});
