import assert from 'node:assert/strict';
const base = new URL(process.argv[2] || 'http://127.0.0.1:3006');
assert.equal(base.hostname, '127.0.0.1');
assert.ok(['3005', '3006'].includes(base.port));
const cases = [
  ['/api/public/storefront/payments', 401, {}],
  ['/api/public/storefront/payments', 401, { Authorization: 'Bearer invalid-test-token' }],
  ['/api/public/storefront/payments/reconcile', 401, {}],
  ['/api/public/storefront/payments/refund', 401, {}],
  ['/api/internal/payments/reconcile', 401, { Authorization: 'Bearer invalid-test-token' }],
  ['/api/public/storefront/payments/wechat-notify', 503, {}],
];
for (let round = 0; round < 10; round++) {
  for (const [path, expected, headers] of cases) {
    const response = await fetch(new URL(path, base), { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const raw = await response.text();
    assert.equal(response.status, expected, `${path}: unexpected status ${response.status}`);
    assert.doesNotMatch(raw, /Network connection lost|PRIVATE KEY|lease_token|payer_openid/);
  }
}
const login = await fetch(new URL('/login', base), { signal: AbortSignal.timeout(15000) });
assert.equal(login.status, 200);
const html = await login.text();
const asset = html.match(/(?:src|href)="(\/assets\/[^"?]+\.(?:js|css))"/);
assert.ok(asset, 'SSR login must reference a real static asset');
const staticResponse = await fetch(new URL(asset[1], base), { signal: AbortSignal.timeout(15000) });
assert.equal(staticResponse.status, 200);
assert.ok((await staticResponse.text()).length > 20);
console.log(JSON.stringify({ rejectedBodyRequests: 60, login: true, staticAsset: true, financialWrites: 0 }));
