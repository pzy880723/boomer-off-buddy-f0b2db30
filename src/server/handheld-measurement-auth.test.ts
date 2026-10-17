import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

type AuthState = {
  deviceOk: boolean;
  session: { user_id: string } | null;
  dbTouched: boolean;
};
const state: AuthState = { deviceOk: true, session: null, dbTouched: false };
(globalThis as any).__measurementAuthTest = state;

const stubs: Record<string, string> = {
  "@tanstack/react-router": "export const createFileRoute = () => options => options;",
  "@/server/handheld-auth.server": `export const HANDHELD_CORS = {};
    export const ok = (data) => Response.json({ ok: true, data });
    export const authenticateDevice = async () => globalThis.__measurementAuthTest.deviceOk
      ? { ok: true, device: { id: "dev", location_id: "loc" } }
      : { ok: false, response: Response.json({ ok: false, code: "unauthorized" }, { status: 401 }) };
    export const resolveSessionUser = async () => globalThis.__measurementAuthTest.session;`,
  "@/lib/handheld/errors": `export const errCode = (code, message) => {
      const status = { unauthorized: 401, unauthorized_role: 403, unauthorized_location: 401, invalid_body: 400, validation_error: 422, not_found: 404, already_exists: 409, revision_conflict: 409, op_conflict: 409, internal_error: 500 }[code] ?? 500;
      return Response.json({ ok: false, code, error: message }, { status });
    };`,
  "@/integrations/supabase/client.server": `const q = new Proxy(function(){}, { get: (_t, k) => k === 'then' ? undefined : () => q, apply: () => q });
    export const supabaseAdmin = new Proxy({}, { get: () => { globalThis.__measurementAuthTest.dbTouched = true; return q; } });`,
  "@/server/product-measurement-production.server": `export const loadMeasurementSku = async () => { globalThis.__measurementAuthTest.dbTouched = true; return null; };
    export const saveMeasurementProduction = async () => { throw new Error("unexpected save"); };
    export const listMeasurementTasksProduction = async () => { throw new Error("unexpected list"); };
    export const claimTaskProduction = async () => { throw new Error("unexpected claim"); };
    export const registerMeasurementAssetProduction = async () => { throw new Error("unexpected register"); };
    export const uploadMeasurementDerivativeProduction = async () => { throw new Error("unexpected upload"); };`,
  "@/lib/measurement.functions": "export const loadMeasurementActor = async () => { throw new Error('unexpected actor load') };",
  "@/server/product-measurement.server": "export const actorCanAccessLocation = () => false; export const validateMeasurementInput = () => ({ ok: false }); export const hasAnyMeasurement = () => false;",
  "@/server/measurement-image.server": "export const MEASUREMENT_IMAGE_MAX_BYTES = 5242880; export const MEASUREMENT_REQUEST_MAX_BYTES = 7340032; export const MEASUREMENT_BASE64_MAX_LEN = 6990508; export const readJsonBodyLimited = async () => { throw new Error('unexpected body read') }; export const decodeStrictBase64 = () => null; export const validateMeasurementImage = async () => { throw new Error('unexpected image validation') }; export const deriveMeasurementPngs = async () => { throw new Error('unexpected derive') };",
  "node:crypto": "export const createHash = () => ({ update: () => ({ digest: () => '' }) });",
};

async function bundleRoute(entry: string) {
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "auth-boundaries",
        setup(builder: any) {
          builder.onResolve({ filter: /^[@:]|^node:/ }, (args: any) => ({ path: args.path, namespace: "stub" }));
          builder.onLoad({ filter: /.*/, namespace: "stub" }, (args: any) => {
            assert.ok(stubs[args.path], `unhandled import ${args.path}`);
            return { contents: stubs[args.path] };
          });
        },
      },
    ],
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  return mod.Route.options ?? mod.Route;
}

const routes = [
  "src/routes/api/public/handheld/items.$id.measurement.ts",
  "src/routes/api/public/handheld/items.$id.measurement-image.ts",
  "src/routes/api/public/handheld/measurements.tasks.ts",
  "src/routes/api/public/handheld/measurements.tasks.$id.claim.ts",
];

for (const entry of routes) {
  test(`${entry}: 无设备凭证 401，无会话 401，均不触库`, async () => {
    const route = await bundleRoute(entry);
    const handlers = route.server.handlers;
    const method = handlers.POST ?? handlers.GET;
    const url = "http://x/?location_id=00000000-0000-0000-0000-00000000000a";
    const req = () => new Request(url, { method: handlers.POST ? "POST" : "GET", body: handlers.POST ? "{}" : undefined });

    state.deviceOk = false;
    state.session = { user_id: "u" };
    state.dbTouched = false;
    let res = await method({ request: req(), params: { id: "00000000-0000-0000-0000-000000000001" } });
    assert.equal(res.status, 401);
    assert.equal(state.dbTouched, false);

    state.deviceOk = true;
    state.session = null;
    state.dbTouched = false;
    res = await method({ request: req(), params: { id: "00000000-0000-0000-0000-000000000001" } });
    assert.equal(res.status, 401);
    assert.equal(state.dbTouched, false);
  });
}
