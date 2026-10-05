import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'points-driver-'));
await build({ entryPoints: ['src/server/youzan-points-operation-production.server.ts'], bundle: true,
  platform: 'node', format: 'esm', packages: 'external', outfile: join(dir, 'driver.mjs'),
  plugins: [{ name: 'test-boundaries', setup(b) {
    b.onResolve({ filter: /^@\/(integrations\/supabase\/client.server|lib\/youzan-http)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.includes('supabase')
      ? 'export const supabaseAdmin = globalThis.pointsFixture.client;'
      : 'export const youzanFetch = (...args) => globalThis.pointsFixture.fetch(...args);', loader: 'js' }));
  } }] });
const member = '11111111-1111-4111-8111-111111111111';
const opId = '22222222-2222-4222-8222-222222222222';
const dbPath = join(dir, 'links.sqlite');
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE member_channel_links(customer_id TEXT,kdt_id INTEGER,yz_id TEXT)');
const events = [];
let begun, claimed, finish = true, active = true, duplicate = false, changeBinding = false;
const head = { kdt_id: 123, parent_kdt_id: null, role: 'hq', status: 'active', access_token: 'private', token_expires_at: '2099-01-01' };
globalThis.pointsFixture = { client: {
  from(table) { const q = { select() { return q; }, eq() { return q; },
    async maybeSingle() { return { data: active ? { id: member } : null, error: null }; },
    then(resolve) { resolve({ data: [head], error: null }); } }; return q; },
  async rpc(name, args) {
    events.push(name);
    if (name.endsWith('_begin')) {
      if (changeBinding) db.prepare('INSERT INTO member_channel_links VALUES (?,123,?)').run(member, 'new-conflict');
      begun = { id: opId, customer_id: args.p_customer_id, kdt_id: args.p_kdt_id,
        source_kdt_id: args.p_source_kdt_id, yz_open_id: args.p_yz_open_id,
        kind: args.p_kind, points: args.p_points, status: duplicate ? 'succeeded' : 'pending' };
      return { data: begun, error: null };
    }
    if (name.endsWith('_claim')) return { data: claimed === null ? null : { ...begun, ...claimed, claim_token: 'lease' }, error: null };
    return { data: finish, error: null };
  },
}, async fetch() { events.push('remote'); return Response.json({ code: 200, success: true, data: { is_success: true } }); } };
const { runProductionPointsOperation: run } = await import(join(dir, 'driver.mjs'));
const input = { operationKey: 'test-operation', customerId: member, sourceKdtId: 123, kind: 'debit', points: 1 };
function reset() {
  events.length = 0; claimed = {}; finish = true; active = true; duplicate = false; changeBinding = false;
  process.env.YOUZAN_MEMBER_LINK_DB = dbPath;
  process.env.YOUZAN_POINTS_WRITE_ENABLED = 'true'; process.env.YOUZAN_POINTS_WRITE_CUSTOMER_IDS = member;
  process.env.YOUZAN_PROXY_URL = 'http://localhost:8787/forward'; process.env.YOUZAN_PROXY_TOKEN = 'test';
  db.exec('DELETE FROM member_channel_links');
  db.prepare('INSERT INTO member_channel_links VALUES (?,123,?)').run(member, 'trusted');
}
test.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
test('production gates prevent journal and remote writes', async () => {
  for (const key of ['YOUZAN_POINTS_WRITE_ENABLED', 'YOUZAN_POINTS_WRITE_CUSTOMER_IDS', 'YOUZAN_PROXY_TOKEN']) {
    reset(); delete process.env[key]; assert.equal((await run(input)).kind, 'blocked'); assert.deepEqual(events, []);
  }
});
test('missing and conflicting trusted bindings cannot start operations', async () => {
  reset(); db.exec('DELETE FROM member_channel_links'); assert.equal((await run(input)).kind, 'blocked');
  reset(); db.prepare('INSERT INTO member_channel_links VALUES (?,123,?)').run('other', 'trusted');
  assert.equal((await run(input)).kind, 'blocked'); assert.deepEqual(events, []);
});
test('durable journal claim precedes remote call and fenced finish', async () => {
  reset(); assert.equal((await run(input)).kind, 'succeeded');
  assert.deepEqual(events, ['youzan_points_operation_begin', 'youzan_points_operation_claim', 'remote', 'youzan_points_operation_finish']);
  reset(); duplicate = true; assert.equal((await run(input)).duplicate, true); assert.equal(events.includes('remote'), false);
  reset(); claimed = null; assert.equal((await run(input)).kind, 'not_claimed'); assert.equal(events.includes('remote'), false);
  reset(); finish = false; assert.equal((await run(input)).kind, 'unconfirmed');
});
test('inactive customers and changed operation identities fail closed', async () => {
  reset(); active = false; assert.equal((await run(input)).kind, 'blocked'); assert.equal(events.includes('remote'), false);
  reset(); claimed = { yz_open_id: 'changed' }; assert.equal((await run(input)).kind, 'blocked'); assert.equal(events.includes('remote'), false);
});
test('malformed proxy URL must never fall back to a direct write', async () => {
  reset(); process.env.YOUZAN_PROXY_URL = 'invalid';
  assert.equal((await run(input)).kind, 'blocked'); assert.deepEqual(events, []);
});
test('a new second member identity while awaiting the journal blocks dispatch', async () => {
  reset(); changeBinding = true;
  assert.equal((await run(input)).kind, 'blocked'); assert.equal(events.includes('remote'), false);
});
