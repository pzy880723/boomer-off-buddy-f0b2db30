import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const account = JSON.parse(readFileSync('/opt/boomer-appstore-review/account.json', 'utf8'));
const origin = process.env.REVIEW_GATEWAY_ORIGIN || 'http://127.0.0.1:3007';
const results = [];
let credentials = {};
async function request(path, method = 'GET', body, expected = 200, authenticated = true) {
  const start = performance.now();
  const response = await fetch(`${origin}/api/public/handheld/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(authenticated ? credentials : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  results.push({ path, method, status: response.status, milliseconds: Math.round(performance.now() - start) });
  assert.equal(response.status, expected, `${path}: ${data.error || data.message || 'unexpected status'}`);
  return data;
}
const bootstrap = await request('auth/bootstrap', 'POST', {
  email: account.email, password: account.password, install_id: 'appstore-review-api-verification',
  device_label: 'App Store independent runtime verification', app_version: '1.1.39',
  capabilities: { has_camera: true },
}, 200, false);
const session = bootstrap.data || bootstrap;
assert.ok(session.device_token.startsWith('rvw_'));
assert.equal(session.user.id, account.id);
assert.equal(session.locations.length, 2);
assert.ok(session.locations.every(location => location.name.startsWith('演示')));
credentials = { 'X-Device-Token': session.device_token, Authorization: `Bearer ${session.access_token}`,
  'X-Session-Token': session.access_token };
await request('locations');
await request('location/switch', 'POST', { location_id: 'de000000-0000-4000-8000-000000000002' });
const products = await request('products?status=all&type=custom');
assert.equal(products.data.items.length, 2);
assert.ok(products.data.items.every(item => item.name.startsWith('演示')));
assert.ok(products.data.items.some(item => item.listing_status === 'sold_out'));
const detail = (await request('items/de000000-0000-4000-8000-000000000101')).data;
assert.equal(detail.attributes.demo, true);
assert.ok(detail.image_url?.startsWith('https://erp.boomeroff.com/review-runtime/api/public/media/sku/'),
  JSON.stringify({ image_present: !!detail.image_url, images_count: detail.images?.length, paths: detail.image_paths,
    image_pathname: detail.image_url ? new URL(detail.image_url).pathname : null }));
const image = await fetch(detail.image_url, { signal: AbortSignal.timeout(15000) });
assert.equal(image.status, 200);
assert.ok(image.headers.get('content-type')?.startsWith('image/'));
const png = Buffer.from(await image.arrayBuffer());
assert.ok(png.subarray(1, 4).toString() === 'PNG' || (png[0] === 0xff && png[1] === 0xd8));
results.push({ path: 'signed-demo-image', method: 'GET', status: image.status, bytes: png.length });
await request('items/de000000-0000-4000-8000-000000000101', 'PATCH', {
  location_id: 'de000000-0000-4000-8000-000000000002', client_op_id: randomUUID(),
  expected_updated_at: detail.updated_at, description: '演示数据：已通过真实编辑保存验证，非真实商品',
});
assert.equal((await request('items/de000000-0000-4000-8000-000000000101')).data.notes,
  '演示数据：已通过真实编辑保存验证，非真实商品');
const orders = await request('orders?status=all');
assert.ok(orders.data.items.some(order => order.id === 'de000000-0000-4000-8000-000000000201'));
const conversations = await request('support/conversations?queue=all');
assert.equal(conversations.data.items.length, 1);
await request('support/conversations/de000000-0000-4000-8000-000000000501?location_id=de000000-0000-4000-8000-000000000002');
await request('dashboard');
await request('privacy/ai-consent', 'POST', { allowed: true, policy_version: '2026-10-09-v1' });
assert.equal((await request('privacy/ai-consent')).data.allowed, true);
await request('privacy/ai-consent', 'POST', { allowed: false, policy_version: '2026-10-09-v1' });
assert.equal((await request('privacy/ai-consent')).data.allowed, false);
await request('privacy/ai-consent', 'POST', { allowed: true, policy_version: 'invalid' }, 409);
const refreshed = await request('auth/refresh', 'POST', { refresh_token: session.refresh_token });
session.access_token = refreshed.data.access_token;
session.session_token = refreshed.data.access_token;
session.refresh_token = refreshed.data.refresh_token;
credentials.Authorization = `Bearer ${session.access_token}`;
credentials['X-Session-Token'] = session.access_token;
await request('locations');
const realCredentials = credentials;
credentials = { 'X-Device-Token': 'rvw_invalid-route-hint' };
await request('products', 'GET', undefined, 401);
credentials = realCredentials;
const productionProbe = await fetch('http://127.0.0.1:3005/api/public/handheld/products', {
  headers: credentials, signal: AbortSignal.timeout(15000),
});
assert.equal(productionProbe.status, 401, 'Demo credentials must not authorize production');
results.push({ path: 'production-rejects-demo-credentials', method: 'GET', status: productionProbe.status });
const staff = JSON.parse(readFileSync('/opt/boomer-appstore-review/staff-account.json', 'utf8'));
const staffLogin = await fetch('http://127.0.0.1:3008/api/public/handheld/auth/bootstrap', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: staff.email, password: staff.password,
    install_id: 'appstore-review-staff-verification', device_label: 'Demo staff scope verification',
    app_version: '1.1.39', capabilities: { has_camera: true } }), signal: AbortSignal.timeout(30000),
});
assert.equal(staffLogin.status, 200);
const staffPayload = await staffLogin.json();
const staffSession = staffPayload.data || staffPayload;
assert.equal(staffSession.user.id, staff.id);
assert.equal(staffSession.locations.length, 1);
assert.equal(staffSession.locations[0].id, 'de000000-0000-4000-8000-000000000002');
results.push({ path: 'demo-staff-single-store', method: 'POST', status: staffLogin.status });
const forbiddenSwitch = await fetch('http://127.0.0.1:3008/api/public/handheld/location/switch', {
  method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Device-Token': staffSession.device_token, 'X-Session-Token': staffSession.access_token,
    Authorization: `Bearer ${staffSession.access_token}` },
  body: JSON.stringify({ location_id: 'de000000-0000-4000-8000-000000000001' }),
  signal: AbortSignal.timeout(15000),
});
assert.equal(forbiddenSwitch.status, 403, 'Demo store staff must not enter headquarters');
results.push({ path: 'demo-staff-hq-forbidden', method: 'POST', status: forbiddenSwitch.status });
writeFileSync('/opt/boomer-appstore-review/verification-session.json', JSON.stringify(session), { mode: 0o600 });
writeFileSync('/opt/boomer-appstore-review/verification-results.json', JSON.stringify(results, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ verified: results, product_response_keys: Object.keys(products), isolated_locations: session.locations.length }));
