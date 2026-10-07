import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('Tencent launcher runs a verified node-server production artifact without Wrangler', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boomer-node-launch-'));
  try {
    mkdirSync(join(dir, '.output/server'), { recursive: true });
    writeFileSync(join(dir, '.env'), 'TEST_BINDING=fixture\n');
    writeFileSync(join(dir, '.output/nitro.json'), JSON.stringify({ preset: 'node-server' }));
    writeFileSync(join(dir, '.output/server/index.mjs'), 'console.log(JSON.stringify({mode:process.env.NODE_ENV,host:process.env.HOST,port:process.env.PORT,binding:process.env.TEST_BINDING}));');
    const result = spawnSync('bash', [resolve('scripts/run-tencent-erp.sh')], { encoding: 'utf8',
      env: { ...process.env, APP_DIR: dir, ERP_PORT: '3306', ERP_BIND_HOST: '127.0.0.1' } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { mode: 'production', host: '127.0.0.1', port: '3306', binding: 'fixture' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function launch(port, override) {
  const root = mkdtempSync(join(tmpdir(), 'erp-workers-'));
  try {
    mkdirSync(join(root, '.output/server'), { recursive: true });
    writeFileSync(join(root, '.env'), 'NODE_ENV=production\n');
    writeFileSync(join(root, 'workers.env'), 'HANDHELD_RELEASE_WORKER_ENABLED=true\nHANDHELD_ITEM_SYNC_WORKER_ENABLED=true\n');
    writeFileSync(join(root, '.output/nitro.json'), JSON.stringify({ preset: 'node-server' }));
    writeFileSync(join(root, '.output/server/index.mjs'), 'console.log(JSON.stringify({ release: process.env.HANDHELD_RELEASE_WORKER_ENABLED, item: process.env.HANDHELD_ITEM_SYNC_WORKER_ENABLED }));');
    const env = { ...process.env, APP_DIR: root, ERP_PORT: port, ERP_WORKER_ENV_FILE: join(root, 'workers.env') };
    delete env.HANDHELD_RELEASE_WORKER_ENABLED;
    delete env.HANDHELD_ITEM_SYNC_WORKER_ENABLED;
    if (override !== undefined) env.HANDHELD_RELEASE_WORKER_ENABLED = override;
    const result = spawnSync('bash', [resolve('scripts/run-tencent-erp.sh')], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('production restarts load persistent worker flags without transient PM2 environment', () => {
  assert.deepEqual(launch('3005'), { release: 'true', item: 'true' });
});
test('candidate never consumes production jobs even if PM2 inherits enabled flags', () => {
  assert.deepEqual(launch('3006', 'true'), { release: 'false', item: 'false' });
});
test('explicit production maintenance disable overrides persistent configuration', () => {
  assert.deepEqual(launch('3005', 'false'), { release: 'false', item: 'true' });
});

for (const port of ['3005', '3006']) {
  test(`sale/channel/order recovery flags are fenced on port ${port}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'erp-sale-flags-'));
    const flags = ['YOUZAN_ORDER_SYNC_WORKER_ENABLED', 'YOUZAN_SALE_COMPENSATION_ENABLED', 'CHANNEL_SYNC_WORKER_ENABLED'];
    try {
      mkdirSync(join(root, '.output/server'), { recursive: true });
      writeFileSync(join(root, '.env'), flags.map(x => `${x}=true`).join('\n') + '\n');
      writeFileSync(join(root, 'workers.env'), flags.map(x => `${x}=true`).join('\n') + '\n');
      writeFileSync(join(root, '.output/nitro.json'), JSON.stringify({ preset: 'node-server' }));
      writeFileSync(join(root, '.output/server/index.mjs'), `console.log(JSON.stringify(${JSON.stringify(flags)}.map(x=>process.env[x])));`);
      const env = { ...process.env, APP_DIR: root, ERP_PORT: port, ERP_WORKER_ENV_FILE: join(root, 'workers.env') };
      for (const flag of flags) env[flag] = port === '3005' ? 'false' : 'true';
      const result = spawnSync('bash', [resolve('scripts/run-tencent-erp.sh')], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ['false', 'false', 'false']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
