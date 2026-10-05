import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const statePath = '/var/lib/boomer-off/youzan-one-point-canary-20261005.json';
const entry = fileURLToPath(new URL('./run-youzan-points-canary.ts', import.meta.url));
const stages = ['prepare', 'seed', 'debit', 'replay', 'refund', 'cleanup', 'verify'];
const customerId = '11111111-1111-4111-8111-111111111111';
let bundle;
let invocation = 0;

before(async () => {
  const mocks = {
    'node:fs': `export const {existsSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync}=globalThis.canaryFixture.fs;`,
    'node:sqlite': `export const DatabaseSync=globalThis.canaryFixture.DatabaseSync;`,
    '../src/integrations/supabase/client.server': `export const supabaseAdmin=globalThis.canaryFixture.client;`,
    '../src/lib/youzan-http': `export const youzanFetch=globalThis.canaryFixture.seed;`,
    '../src/server/youzan-points-query.server': `export const selectPointsHeadquarters=()=>globalThis.canaryFixture.head;
      export const createYouzanPointsQuery=()=>async()=>({kind:'ok',observed:{point:globalThis.canaryFixture.remote}});`,
    '../src/server/youzan-points-operation.server': `export const createYouzanPointsOperation=()=>globalThis.canaryFixture.replay;`,
    '../src/server/youzan-points-operation-production.server': `export const runProductionPointsOperation=globalThis.canaryFixture.operation;`,
  };
  const result = await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false,
    define: {
      process: 'globalThis.canaryFixture.process',
      console: 'globalThis.canaryFixture.console',
      fetch: 'globalThis.canaryFixture.forbidNetwork',
      setTimeout: 'globalThis.canaryFixture.setTimeout',
    },
    plugins: [{ name: 'offline-canary-boundaries', setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (args.kind === 'entry-point') return { path: resolve(args.path) };
        if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: 'mock' };
        if (['node:assert/strict', 'node:crypto', 'node:path'].includes(args.path)) return { path: args.path, external: true };
        throw Error(`Unmocked canary dependency: ${args.path}`);
      });
      b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    } }],
  });
  bundle = result.outputFiles[0].text;
});

function fixture() {
  const files = new Map();
  const descriptors = new Map();
  const operations = new Map();
  const seeds = new Set();
  const f = {
    remote: 0, local: 3000, events: [], calls: [], output: [], loseSeedResponse: false,
    head: { kdt_id: 123, role: 'hq', status: 'active', access_token: 'mock-token' },
    process: { argv: ['node', entry], env: {
      YOUZAN_ONE_POINT_CANARY_AUTHORIZED: '20261005-original-test-member-restore-zero',
      YOUZAN_PROXY_URL: 'http://offline.invalid', YOUZAN_PROXY_TOKEN: 'mock-token',
    } },
    forbidNetwork() { throw Error('Live network is forbidden'); },
    setTimeout(callback) { callback(); },
  };
  f.console = { log: value => f.output.push(JSON.parse(value)) };
  f.DatabaseSync = class {
    constructor(_path, options) { assert.equal(options.readOnly, true); }
    prepare() { return { all: () => [{ customer_id: customerId, kdt_id: 123, yz_id: 'trusted-test-member' }] }; }
    close() {}
  };
  f.client = { from(table) {
    assert.ok(['youzan_shops', 'pos_customer_wallets'].includes(table));
    const q = {
      select() { return q; }, eq() { return q; },
      single: async () => ({ data: { points: f.local }, error: null }),
      then: (yes, no) => Promise.resolve({ data: [f.head], error: null }).then(yes, no),
    };
    return q;
  } };
  // All descriptors and renames are in memory; record ordering without touching /var/lib.
  let nextFd = 1;
  f.fs = {
    existsSync: path => files.has(path),
    readFileSync(path) { assert.ok(files.has(path)); return files.get(path); },
    openSync(path, flags) {
      assert.ok([statePath, `${statePath}.tmp`, dirname(statePath)].includes(path));
      if (flags === 'w') files.set(path, '');
      const fd = nextFd++; descriptors.set(fd, path); return fd;
    },
    writeFileSync(fd, contents) { files.set(descriptors.get(fd), String(contents)); },
    fsyncSync(fd) {
      assert.ok(descriptors.has(fd));
      f.events.push({ type: 'fsync', path: descriptors.get(fd) });
    },
    closeSync(fd) { assert.ok(descriptors.delete(fd)); },
    renameSync(from, to) {
      assert.ok(files.has(from)); files.set(to, files.get(from)); files.delete(from);
      f.events.push({ type: 'rename', path: to });
    },
  };
  f.state = () => JSON.parse(files.get(statePath));
  f.seed = async (_url, init) => {
    const { params } = JSON.parse(init.body);
    assert.equal(params.points, 1);
    assert.equal(params.user.account_id, 'trusted-test-member');
    assert.equal(params.source_kdt_id, 123);
    f.calls.push({ stage: 'seed', params }); f.events.push({ type: 'mutation' });
    if (!seeds.has(params.biz_value)) { seeds.add(params.biz_value); f.remote++; }
    if (f.loseSeedResponse) { f.loseSeedResponse = false; throw Error('seed_response_lost'); }
    return Response.json({ code: 200, success: true, data: { is_success: true } });
  };
  f.operation = async input => {
    assert.equal(input.customerId, customerId); assert.equal(input.sourceKdtId, 123);
    assert.equal(input.points, 1);
    const stage = input.operationKey.split(':').at(-1);
    assert.ok(['debit', 'refund', 'cleanup'].includes(stage));
    assert.equal(input.kind, stage === 'refund' ? 'refund' : 'debit');
    if (stage === 'refund') assert.equal(input.parentId, f.state().debitId);
    f.calls.push({ stage, input }); f.events.push({ type: 'mutation' });
    const old = operations.get(input.operationKey);
    if (old) return { kind: 'succeeded', operationId: old.id, duplicate: true };
    const op = { ...input, id: randomUUID() }; operations.set(input.operationKey, op);
    f.remote += input.kind === 'refund' ? 1 : -1;
    return { kind: 'succeeded', operationId: op.id, duplicate: false };
  };
  f.replay = async op => {
    const original = [...operations.values()].find(row => row.id === op.id);
    assert.ok(original, 'replay must reuse the original durable debit ID');
    assert.equal(op.kind, 'debit'); assert.equal(op.points, 1);
    assert.equal(op.customer_id, customerId); assert.equal(op.yz_open_id, 'trusted-test-member');
    f.calls.push({ stage: 'replay', op }); f.events.push({ type: 'mutation' });
    return { kind: 'succeeded' };
  };
  return f;
}

async function run(f, stage) {
  f.process.argv[2] = stage;
  globalThis.canaryFixture = f;
  try {
    const source = `${bundle}\n// invocation ${++invocation}`;
    await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  } finally {
    delete globalThis.canaryFixture;
  }
}

test('completed verify still rejects a nonzero remote balance', async () => {
  const f = fixture();
  for (const stage of stages) await run(f, stage);
  f.remote = 1;
  const calls = f.calls.length;
  await assert.rejects(run(f, 'verify'), { code: 'ERR_ASSERTION' });
  assert.equal(f.calls.length, calls, 'verification must not mutate assets');
});

test('state renames fsync the parent directory before further saves or mutations', async () => {
  const f = fixture();
  await run(f, 'prepare');
  await run(f, 'seed');
  const renames = f.events.flatMap((event, index) => event.type === 'rename' ? [index] : []);
  assert.ok(renames.length > 0);
  for (const index of renames) {
    assert.deepEqual(f.events[index - 1], { type: 'fsync', path: `${statePath}.tmp` });
    const nextBoundary = f.events.findIndex((event, i) => i > index && ['rename', 'mutation'].includes(event.type));
    const following = f.events.slice(index + 1, nextBoundary < 0 ? undefined : nextBoundary);
    assert.ok(following.some(event => event.type === 'fsync' && event.path === dirname(statePath)),
      'state rename must be followed by parent directory fsync before continuing');
  }
});

test('approved stages restore remote zero and ERP 3000; completed stages do not repeat writes', async () => {
  const f = fixture();
  const balances = [];
  for (const stage of stages) {
    await run(f, stage); balances.push(f.remote);
    const calls = f.calls.length;
    await run(f, stage);
    assert.equal(f.calls.length, calls);
  }
  assert.deepEqual(balances, [0, 1, 0, 0, 1, 0, 0]);
  assert.deepEqual(f.calls.map(call => call.stage), ['seed', 'debit', 'replay', 'refund', 'cleanup']);
  assert.deepEqual(f.state().completed, stages);
  assert.equal(f.state().started, undefined);
  assert.equal(f.remote, 0); assert.equal(f.local, 3000);
  assert.equal(f.output.at(-1).remoteBalance, 0);
});

test('seed response loss resumes the persisted seed ID rather than granting a second point', async () => {
  const f = fixture();
  await run(f, 'prepare');
  const seedId = f.state().seedId;
  f.loseSeedResponse = true;
  await assert.rejects(run(f, 'seed'), /seed_response_lost/);
  assert.equal(f.state().started, 'seed');
  assert.equal(f.remote, 1);
  await run(f, 'seed');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].params.biz_value, `boomer-canary:${seedId}`);
  assert.deepEqual(f.calls[1].params, f.calls[0].params);
  assert.equal(f.remote, 1); assert.equal(f.local, 3000);
  assert.deepEqual(f.state().completed, ['prepare', 'seed']);
});
