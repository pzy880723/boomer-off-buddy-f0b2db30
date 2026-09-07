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
