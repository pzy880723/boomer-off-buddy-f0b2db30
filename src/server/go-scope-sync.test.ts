// Run: node --experimental-strip-types --test src/server/go-scope-sync.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any -- HTTP/database fixtures and bundled route boundary. */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const PROJECT = "narqwgwpqglathwtyevz";
const ID = "11111111-1111-4111-8111-111111111111";
const KEY = "isolated-ack-fixture-key";
const priorKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
after(() => {
  if (priorKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = priorKey;
});

let row: Record<string, any>;
let requests: { method: string; url: URL }[];
let beforePatch: (() => void | Promise<void>) | null;
let afterRead: (() => Promise<void>) | null;
let failWrites: boolean;

function matches(value: unknown, filter: string) {
  if (filter.startsWith("eq.")) return String(value) === filter.slice(3);
  if (filter.startsWith("neq.")) return String(value) !== filter.slice(4);
  throw new Error(`Unexpected filter: ${filter}`);
}

// Real Supabase query serialization and real handler; only database HTTP is fake.
// PATCH evaluates its predicates atomically after any injected concurrent update.
const db = createClient("https://ack-fixture.invalid", KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "ack-fixture.invalid", "never contact a real database");
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      const table = url.pathname.split("/").at(-1);
      if (table === "go_shop_location_links") return Response.json([]);
      assert.equal(table, "go_scope_sync_outbox");
      if (method === "PATCH") {
        if (failWrites) return Response.json({ message: "fixture write failed" }, { status: 500 });
        const hook = beforePatch;
        beforePatch = null;
        await hook?.();
      }
      const included = [...url.searchParams].every(
        ([key, filter]) =>
          ["select", "order", "limit", "or"].includes(key) || matches(row[key], filter),
      );
      if (method === "PATCH" && included) Object.assign(row, JSON.parse(String(init?.body)));
      const columns = url.searchParams.get("select")?.split(",");
      const rows = included ? [{ ...row }] : [];
      const data = columns
        ? rows.map((r) => Object.fromEntries(columns.map((key) => [key, r[key]])))
        : rows;
      if (method === "GET") await afterRead?.();
      const returnsRows =
        method === "GET" ||
        new Headers(init?.headers).get("prefer")?.includes("return=representation");
      return returnsRows ? Response.json(data) : new Response(null, { status: 204 });
    },
  },
});
(globalThis as any).__goAckFixtureDb = db;

const root = fileURLToPath(new URL("../../", import.meta.url));
const bundled = await build({
  stdin: {
    contents: "export { Route } from './src/routes/api/public/go/scope-sync.ts';",
    resolveDir: root,
    loader: "ts",
  },
  absWorkingDir: root,
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "ack-route-boundaries",
      setup(builder: any) {
        builder.onResolve({ filter: /^@tanstack\/react-router$|client\.server$/ }, (args: any) => ({
          path: args.path,
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args: any) => ({
          contents:
            args.path === "@tanstack/react-router"
              ? "export const createFileRoute = () => options => options;"
              : "export const supabaseAdmin = globalThis.__goAckFixtureDb;",
        }));
      },
    },
  ],
});
const { Route } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
async function request(body: unknown, token = KEY) {
  const response: Response = await Route.server.handlers.POST({
    request: new Request("https://erp-fixture.invalid/api/public/go/scope-sync", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  return { status: response.status, body: await response.json() };
}
const ack = (ok = true, version = 4) =>
  request({ action: "ack", results: [{ id: ID, ok, version, error: "fixture failure" }] });
const patches = () => requests.filter((r) => r.method === "PATCH");

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
  row = {
    id: ID,
    go_project_ref: PROJECT,
    version: 4,
    status: "pending",
    attempts: 0,
    change_kind: "revoke",
    subject_type: "user_scope",
    subject_key: "employee",
    target_user_id: "employee",
    payload: {},
    synced_at: null,
    last_error: null,
    next_attempt_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  };
  requests = [];
  beforePatch = null;
  afterRead = null;
  failWrites = false;
});

for (const version of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4", true]) {
  test(`rejects the whole batch before any write for invalid version ${String(version)}`, async () => {
    const result = await request({
      action: "ack",
      results: [
        { id: ID, ok: true, version: 4 },
        { id: ID, ok: true, version },
      ],
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_ack_version");
    assert.equal(patches().length, 0);
    assert.equal(row.status, "pending");
  });
}

test("old successful ACK cannot clear same-ID v5 revoke inserted after v4 pull", async () => {
  beforePatch = () => {
    row.version = 5;
    row.status = "pending";
    row.change_kind = "revoke";
  };
  const result = await ack();
  assert.deepEqual(result.body, { ok: true, synced: 0, failed: 0, skipped: 1 });
  assert.equal(row.version, 5);
  assert.equal(row.status, "pending");
});

test("late old failure cannot overwrite an already synced newer generation", async () => {
  row.version = 5;
  row.status = "synced";
  const result = await ack(false);
  assert.deepEqual(result.body, { ok: true, synced: 0, failed: 0, skipped: 1 });
  assert.equal(row.status, "synced");
  assert.equal(row.attempts, 0);
});

test("failure for a generation already synced is also a no-op", async () => {
  row.status = "synced";
  const result = await ack(false);
  assert.equal(result.body.skipped, 1);
  assert.equal(row.status, "synced");
  assert.equal(row.attempts, 0);
});

test("duplicate successful ACK counts only the first actual transition", async () => {
  assert.deepEqual((await ack()).body, { ok: true, synced: 1, failed: 0, skipped: 0 });
  const syncedAt = row.synced_at;
  assert.deepEqual((await ack()).body, { ok: true, synced: 0, failed: 0, skipped: 1 });
  assert.equal(row.synced_at, syncedAt);
});

test("concurrent successful ACKs confirm one transition and skip the duplicate", async () => {
  const results = await Promise.all([ack(), ack()]);
  assert.equal(
    results.reduce((sum, r) => sum + r.body.synced, 0),
    1,
  );
  assert.equal(
    results.reduce((sum, r) => sum + r.body.skipped, 0),
    1,
  );
});

test("concurrent failures do not lose attempts increments", async () => {
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  afterRead = async () => {
    reads += 1;
    if (reads === 2) {
      afterRead = null;
      release();
    }
    await bothRead;
  };
  const results = await Promise.all([ack(false), ack(false)]);
  assert.equal(row.attempts, 2);
  assert.equal(row.status, "failed");
  assert.equal(
    results.reduce((sum, r) => sum + r.body.failed, 0),
    2,
  );
  assert.equal(
    results.reduce((sum, r) => sum + r.body.skipped, 0),
    0,
  );
});

test("a success arriving between failure read and write cannot be undone", async () => {
  beforePatch = () => {
    row.status = "synced";
    row.synced_at = "confirmed";
  };
  const result = await ack(false);
  assert.equal(result.body.failed, 0);
  assert.equal(result.body.skipped, 1);
  assert.equal(row.status, "synced");
  assert.equal(row.attempts, 0);
});

test("a new generation arriving between failure read and write remains pending", async () => {
  beforePatch = () => {
    row.version = 5;
    row.status = "pending";
    row.attempts = 0;
  };
  const result = await ack(false);
  assert.deepEqual(result.body, { ok: true, synced: 0, failed: 0, skipped: 1 });
  assert.equal(row.version, 5);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
});

test("sustained attempts contention is bounded and never counted as an actual failed write", async () => {
  const collide = () => {
    row.attempts += 1;
    beforePatch = collide;
  };
  beforePatch = collide;
  const result = await ack(false);
  assert.deepEqual(result.body, { ok: true, synced: 0, failed: 0, skipped: 1 });
  assert.equal(patches().length, 3);
  assert.equal(row.attempts, 3, "only the competing writer increments are retained");
});

test("wrong-project and missing rows count as skipped, never confirmed", async () => {
  row.go_project_ref = "another-project";
  assert.deepEqual((await ack()).body, { ok: true, synced: 0, failed: 0, skipped: 1 });
  assert.deepEqual((await ack(false)).body, { ok: true, synced: 0, failed: 0, skipped: 1 });
  assert.equal(row.status, "pending");
  row.go_project_ref = PROJECT;
  row.id = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual((await ack()).body, { ok: true, synced: 0, failed: 0, skipped: 1 });
  assert.deepEqual((await ack(false)).body, { ok: true, synced: 0, failed: 0, skipped: 1 });
});

test("service-role authentication remains mandatory and runs before database access", async () => {
  const result = await request(
    { action: "ack", results: [{ id: ID, version: 4, ok: true }] },
    "wrong-key",
  );
  assert.equal(result.status, 401);
  assert.equal(requests.length, 0);
});

test("database write errors are not reported as successful acknowledgements", async () => {
  failWrites = true;
  const result = await ack();
  assert.equal(result.status, 500);
  assert.equal(result.body.ok, false);
  assert.equal(row.status, "pending");
});

test("pull preserves the event version and existing catalog/changes contract", async () => {
  const result = await request({ action: "pull" });
  assert.equal(result.status, 200);
  assert.equal(result.body.go_project_ref, PROJECT);
  assert.equal(result.body.changes[0].id, ID);
  assert.equal(result.body.changes[0].version, 4);
  assert.deepEqual(result.body.shops, []);
  assert.equal(patches().length, 0);
});
