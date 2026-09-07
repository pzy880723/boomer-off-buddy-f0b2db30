import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const source = path => readFileSync(new URL(path, root), 'utf8');
const clean = code => stripTypeScriptTypes(code.replace(/^import[\s\S]*?;\n/gm, '').replaceAll('export ', ''));
const secret = 'local-test-only-service-key';
const publicKey = 'local-test-only-public-key';

function harness({ env = { SUPABASE_SERVICE_ROLE_KEY: secret, SUPABASE_PUBLISHABLE_KEY: publicKey }, roles = [], roleError = null } = {}) {
  const effects = { db: 0, dispatch: [], runs: 0, reaps: 0, roleUsers: [] };
  const sb = { from(table) {
    if (table === 'user_roles') return { select: () => ({ eq: async (_column, userId) => {
      effects.roleUsers.push(userId);
      return { data: roles.map(role => ({ role })), error: roleError };
    } }) };
    effects.db++;
    return { select: () => ({ eq: async () => ({ data: [{ id: 'shop', role: 'branch' }], error: null }) }) };
  } };
  const context = {
    process: { env }, Response, Request, URL, Date, JSON, crypto, Buffer,
    console: { error() {} },
    supabaseAdmin: sb, supabase: sb,
    fetch: async (url, init) => { effects.dispatch.push({ url, init }); return Response.json({ ok: true }); },
  };
  const helperPath = new URL('server/youzan-sync-auth.server.ts', root);
  if (existsSync(helperPath)) Object.assign(context, vm.runInNewContext(`${clean(readFileSync(helperPath, 'utf8'))}\n({requireYouzanSyncService,assertYouzanSyncOperator,dispatchYouzanSyncWorker})`, context));
  return { context, effects };
}

function route(kind, options) {
  const h = harness(options);
  const ctx = { ...h.context, createFileRoute: () => value => value,
    enqueueOrderSyncWindows: async () => { h.effects.db++; return { windows: 1 }; },
    runOrderSyncSliceOnce: async () => { h.effects.runs++; return { claimed: false }; },
    runShopSyncCore: async () => { h.effects.runs++; return { ok: true, count: 2, message: 'ok' }; },
  };
  const value = vm.runInNewContext(`${clean(source(`routes/api/public/hooks/${kind}.ts`))}\nRoute`, ctx);
  return { ...h, post(headers = {}, body = { shop_id: 'shop', action: 'orders', days: 3 }, url = `https://untrusted.test/api/public/hooks/${kind}`) {
    return value.server.handlers.POST({ request: new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }) });
  } };
}

for (const kind of ['youzan-sync', 'youzan-sync-worker']) {
  for (const [name, headers, options, expected] of [
    ['missing header', {}, {}, 401],
    ['wrong bearer', { authorization: 'Bearer wrong' }, {}, 401],
    ['public apikey', { apikey: publicKey }, {}, 401],
    ['public bearer', { authorization: `Bearer ${publicKey}` }, {}, 401],
    ['missing service env', { authorization: `Bearer ${secret}` }, { env: {} }, 503],
  ]) test(`${kind}: ${name} rejected before all sync side effects`, async () => {
    const h = route(kind, options);
    const response = await h.post(headers);
    assert.equal(response.status, expected);
    assert.equal(h.effects.db, 0);
    assert.equal(h.effects.runs, 0);
    assert.equal(h.effects.dispatch.length, 0);
  });
  test(`${kind}: trusted server bearer preserves response contract`, async () => {
    const h = route(kind);
    const response = await h.post({ authorization: `Bearer ${secret}` });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(h.effects.runs, 1);
  });
}

for (const port of [undefined, '3006']) test(`cron uses fixed loopback ${port ?? '3005'}, service bearer and no redirects`, async () => {
  const h = route('youzan-sync', { env: { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: port } });
  await h.post({ authorization: `Bearer ${secret}` });
  assert.equal(h.effects.dispatch.length, 1);
  const { url, init } = h.effects.dispatch[0];
  assert.equal(url, `http://127.0.0.1:${port ?? '3005'}/api/public/hooks/youzan-sync-worker`);
  assert.equal(init.headers.Authorization, `Bearer ${secret}`);
  assert.equal(init.redirect, 'error');
});

function manual(name, options) {
  const h = harness(options);
  const original = source('lib/youzan.functions.ts');
  const start = original.indexOf(`export const ${name} =`);
  const fnSource = original.slice(start, original.indexOf('\n  });', start) + 6);
  let middleware = [];
  const requireSupabaseAuth = Symbol('requireSupabaseAuth');
  const chain = { middleware(value) { middleware = value; return this; }, inputValidator() { return this; }, handler(fn) { return fn; } };
  const helperStart = original.indexOf('function dispatchYouzanSyncWorker(');
  const oldDispatch = helperStart === -1 ? '' : original.slice(helperStart, original.indexOf('\n\n\nasync function getShopOr404', helperStart));
  const fn = vm.runInNewContext(`${clean(oldDispatch + '\n' + fnSource)}\n${name}`, {
    ...h.context, createServerFn: () => chain, requireSupabaseAuth,
    getRequestUrl: () => 'https://untrusted.test/rpc',
    getYouzanSyncActions: () => ['items', 'orders'],
    reapStaleSyncLogs: async () => { h.effects.reaps++; },
    getShopOr404: async () => { h.effects.db++; return { id: 'shop' }; },
    runItemsSyncForShop: async () => { h.effects.runs++; return { ok: true, count: 1, message: 'ok' }; },
    runOrdersSyncForShop: async () => { h.effects.runs++; return { ok: true, count: 1, message: 'ok' }; },
  });
  return { ...h, invoke: async (userId = 'actor') => {
    if (middleware.includes(requireSupabaseAuth) && !userId) throw new Response(null, { status: 401 });
    return fn({ data: { shop_id: 'shop', days: 3 }, context: { userId } });
  } };
}

for (const name of ['syncYouzanItems', 'syncYouzanOrders', 'syncAllShops']) {
  for (const [label, roles, userId, status, roleError] of [
    ['anonymous', [], '', 401],
    ['staff', ['store_staff'], 'actor', 403],
    ['store manager', ['store_manager'], 'actor', 403],
    ['missing role', [], 'actor', 403],
    ['role lookup failed', ['super_admin'], 'actor', 503, { message: 'db unavailable' }],
  ]) test(`${name}: ${label} cannot start any business work`, async () => {
    const h = manual(name, { roles, roleError });
    await assert.rejects(h.invoke(userId), e => e.status === status);
    assert.equal(h.effects.db, 0);
    assert.equal(h.effects.reaps, 0);
    assert.equal(h.effects.runs, 0);
    assert.equal(h.effects.dispatch.length, 0);
    if (!userId) assert.equal(h.effects.roleUsers.length, 0);
  });
  for (const role of ['super_admin', 'hq_operator']) test(`${name}: ERP ${role} remains allowed`, async () => {
    const h = manual(name, { roles: [role] });
    const result = await h.invoke();
    assert.deepEqual(h.effects.roleUsers, ['actor']);
    if (name === 'syncAllShops') {
      assert.equal(result.shopCount, 1);
      assert.equal(h.effects.dispatch.length, 2);
      for (const { url, init } of h.effects.dispatch) {
        assert.equal(url, 'http://127.0.0.1:3005/api/public/hooks/youzan-sync-worker');
        assert.equal(init.headers.Authorization, `Bearer ${secret}`);
        assert.equal(init.redirect, 'error');
      }
    } else assert.equal(result.ok, true);
  });
}
