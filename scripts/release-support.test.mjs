import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Script } from 'node:vm';

const BASE = '/var/www/boomer-erp';
const PREVIOUS = `${BASE}/releases/previous-release`;
const RELEASE = `${BASE}/releases/support-ddb3697-20261006`;
const OTHER = `${BASE}/releases/support-abcdef0-20261006`;
const PRODUCTION = 'boomer-off-buddy';
const CANDIDATE = 'boomer-support-candidate';

function processRecord(name, dir, port) {
  return { name, pm2_env: { status: 'online', pm_cwd: dir,
    pm_exec_path: `${dir}/scripts/run-tencent-erp.sh`, APP_DIR: dir, ERP_PORT: String(port),
    env: { APP_DIR: dir, ERP_PORT: String(port) } } };
}

function releaseHarness({ existingCandidate = false, onFetch, onPortCheck } = {}) {
  const state = {
    current: PREVIOUS,
    processes: new Map([[PRODUCTION, processRecord(PRODUCTION, PREVIOUS, 3005)]]),
    files: new Map(),
    events: [],
  };
  if (existingCandidate) state.processes.set(CANDIDATE, processRecord(CANDIDATE, OTHER, 3006));
  const source = readFileSync(new URL('./release-support.mjs', import.meta.url), 'utf8');
  // Keep the real control flow, but every imported effect and global network call is fake.
  const isolatedSource = source.replace(
    /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/gm,
    (_, binding, module) => `const ${binding} = __modules[${JSON.stringify(module)}];`,
  );
  let sequence = 0;
  function run(release = RELEASE) {
    const runID = ++sequence;
    const descriptors = new Map();
    const record = (action, details = {}) => state.events.push({ runID, action, ...details });
    const occupied = (path) => {
      if (state.files.has(path)) throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
    };
    const fs = {
      constants: { W_OK: 2 },
      accessSync() {},
      readlinkSync: path => path === `${BASE}/current` ? state.current : state.files.get(path),
      realpathSync: path => path === `${BASE}/current` ? state.current : path,
      existsSync: path => state.files.has(path),
      symlinkSync: (target, path) => state.files.set(path, target),
      renameSync: (from, to) => {
        if (to === `${BASE}/current`) {
          state.current = state.files.get(from);
          record('point-current', { dir: state.current });
        } else state.files.set(to, state.files.get(from));
        state.files.delete(from);
      },
      unlinkSync: path => state.files.delete(path),
      mkdirSync: path => { occupied(path); state.files.set(path, 'directory'); },
      rmdirSync: path => state.files.delete(path),
      openSync: (path, flags) => {
        assert.equal(flags, 'wx', 'Only exclusive lock-file opens are modeled');
        occupied(path); state.files.set(path, 'lock'); descriptors.set(runID, path); return runID;
      },
      writeFileSync: (file, data) => {
        const path = typeof file === 'number' ? descriptors.get(file) : file;
        assert.ok(path, 'Writing an unopened mock descriptor is forbidden');
        state.files.set(path, data);
      },
      closeSync: fd => { assert.ok(descriptors.delete(fd), 'Closing an unopened mock descriptor'); },
    };
    const execFileSync = (command, args, options) => {
      if (command === 'ss') {
        const result = state.processes.has(CANDIDATE) ? 'LISTEN 3006' : '';
        onPortCheck?.({ state, runID, run });
        return result;
      }
      assert.equal(command, 'pm2', `Unmocked command forbidden: ${command}`);
      const [action, name] = args;
      if (action === 'jlist') return JSON.stringify([...state.processes.values()]);
      if (action === 'start') {
        const name = args[args.indexOf('--name') + 1];
        record('start', { name, dir: options.env.APP_DIR });
        if (state.processes.has(name)) throw new Error('process_name_in_use');
        state.processes.set(name, processRecord(name, options.env.APP_DIR, options.env.ERP_PORT));
      } else if (action === 'delete') {
        record('delete', { name, dir: state.processes.get(name)?.pm2_env.APP_DIR });
        state.processes.delete(name);
      } else if (action === 'save') record('save');
      else assert.fail(`Unmocked PM2 action forbidden: ${action}`);
      return '';
    };
    const modules = { 'node:assert/strict': assert, 'node:fs': fs, 'node:child_process': { execFileSync } };
    const context = {
      __modules: new Proxy(modules, { get(target, key) {
        assert.ok(Object.hasOwn(target, key), `Unmocked module forbidden: ${String(key)}`);
        return target[key];
      } }),
      process: { env: { SUPPORT_PREVIOUS_DIR: PREVIOUS, SUPPORT_RELEASE_DIR: release }, pid: runID },
      console: { log() {}, error() {} },
      AbortSignal: { timeout: () => undefined },
      setTimeout: callback => queueMicrotask(callback),
      fetch: async (url, options = {}) => {
        onFetch?.({ state, runID, url });
        const name = url.includes(':3006/') ? CANDIDATE : PRODUCTION;
        assert.ok(state.processes.has(name), `Mock server is offline: ${name}`);
        return { ok: true, status: options.method === 'OPTIONS' ? 204
          : url.includes('/support/conversations') ? 401 : 200,
        headers: { get: () => 'application/json' } };
      },
    };
    return new Script(`(async () => {\n${isolatedSource}\n})()`, { filename: 'release-support.isolated.mjs' })
      .runInNewContext(context, { timeout: 1000 });
  }
  return { state, run };
}

test('support release refuses stale current, preserves worker flags and rolls back on failure', () => {
  const script = readFileSync(new URL('./release-support.mjs', import.meta.url), 'utf8');
  assert.match(script, /SUPPORT_PREVIOUS_DIR/);
  assert.match(script, /Another deployment changed current/);
  assert.match(script, /start\(previous, 'boomer-off-buddy', 3005\)/);
  assert.match(script, /YOUZAN_IMAGE_REFRESH_WORKER_ENABLED/);
  assert.ok(script.indexOf("pm('delete', candidate)") < script.indexOf("pm('save')"));
});
test('support candidate materializes dependencies and excludes secrets before extracting overlay', () => {
  const script = readFileSync(new URL('./prepare-support-candidate.sh', import.meta.url), 'utf8');
  assert.match(script, /release_archive_contains_environment/);
  assert.match(script, /readlink -f "\$old\/node_modules"/);
  assert.match(script, /--exclude='\.env\.\*'/);
  assert.ok(script.indexOf('release_archive_contains_environment') < script.indexOf('tar -C "$release" -xf'));
});

test('isolated release succeeds and saves only after removing its own candidate', async () => {
  const { state, run } = releaseHarness();
  await run();
  assert.equal(state.current, RELEASE);
  assert.equal(state.processes.get(PRODUCTION)?.pm2_env.APP_DIR, RELEASE);
  assert.equal(state.processes.has(CANDIDATE), false);
  const cleanup = state.events.findIndex(e => e.action === 'delete' && e.name === CANDIDATE);
  assert.ok(cleanup >= 0 && state.events.findIndex(e => e.action === 'save') > cleanup);
});

test('an existing candidate belongs to another run and must not be cleaned up', async () => {
  const { state, run } = releaseHarness({ existingCandidate: true });
  await assert.rejects(run());
  assert.deepEqual(state.events.filter(e => ['delete', 'start', 'point-current', 'save'].includes(e.action)), [],
    'Refusing a pre-existing candidate must not mutate another deployment');
  assert.equal(state.processes.get(CANDIDATE)?.pm2_env.APP_DIR, OTHER);
  assert.equal(state.current, PREVIOUS);
});

test('verification failure after a concurrent switch must not roll back or delete the new owner', async () => {
  let switchedAt;
  const { state, run } = releaseHarness({ onFetch({ state, url }) {
    if (url !== 'http://127.0.0.1:3005/pos') return;
    state.current = OTHER;
    state.processes.set(PRODUCTION, processRecord(PRODUCTION, OTHER, 3005));
    switchedAt = state.events.length;
    throw new Error('verification_interrupted_after_other_deployment');
  } });
  await assert.rejects(run());
  assert.notEqual(switchedAt, undefined, 'Must reach production verification, not fail during setup');
  assert.deepEqual(state.events.slice(switchedAt).filter(e =>
    e.name === PRODUCTION || e.action === 'point-current' || e.action === 'save'), [],
  'Lost ownership must prevent production deletion, rollback and saving another run\'s PM2 state');
  assert.equal(state.current, OTHER);
  assert.equal(state.processes.get(PRODUCTION)?.pm2_env.APP_DIR, OTHER);
});

test('two invocations are mutually exclusive across the port-check/start window', async () => {
  let second;
  let entered = false;
  const { state, run } = releaseHarness({ onPortCheck({ run }) {
    if (entered) return;
    entered = true;
    // A second process can pass the same preflight before the first starts PM2.
    second = run(OTHER).then(() => ({ ok: true }), error => ({ ok: false, error }));
  } });
  const first = await run().then(() => ({ ok: true }), error => ({ ok: false, error }));
  assert.ok(second, 'Must interleave two actual script executions');
  const outcomes = [first, await second];
  assert.equal(state.events.filter(e => e.action === 'start' && e.name === CANDIDATE).length, 1,
    'Only the lock owner may attempt candidate startup');
  assert.equal(outcomes.filter(result => result.ok).length, 1, 'Exactly one deployment succeeds');
  assert.equal(state.events.filter(e => e.action === 'delete' && e.name === PRODUCTION).length, 1);
  assert.equal(state.current, state.processes.get(PRODUCTION)?.pm2_env.APP_DIR);
});
