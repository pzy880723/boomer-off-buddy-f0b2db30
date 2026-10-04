import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createUploadRelayGrant, relayImageUpload } from '../src/server/handheld-upload-relay.server.ts';

const secret = 'test-only-key';
const storageOrigin = 'https://storage.example.test';
const target = `${storageOrigin}/storage/v1/object/upload/sign/sku-raw/2026-10-04/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.jpg?token=secret-upstream-token`;
const grant = (now = Date.now()) => createUploadRelayGrant(target, 'image/jpeg', secret, storageOrigin, now);
const request = (token = grant(), body = new Uint8Array([255, 216, 1, 255, 217]), headers = {}) => new Request('https://erp.example.test/api/public/handheld/items/upload-image', {
  method: 'PUT', headers: { 'X-Upload-Token': token, 'Content-Type': 'image/jpeg', ...headers }, body,
});
const options = (f) => ({ secret, storageOrigin, fetch: f });

test('signed upload uses ERP relay and keeps the existing PUT/header contract', async () => {
  const route = await readFile(new URL('../src/routes/api/public/handheld/items.upload-image.ts', import.meta.url), 'utf8');
  assert.match(route, /createUploadRelayGrant/);
  assert.match(route, /PUT:.*relayImageUpload/s);
  assert.doesNotMatch(route, /upload_url: signedUpload.data.signedUrl/);
  assert.match(route, /method: "PUT"/);
});

test('forwards unchanged bytes only to signed storage, without ERP credentials', async () => {
  let calls = 0;
  const r = await relayImageUpload(request(grant(), undefined, { Authorization: 'Bearer must-not-forward', 'X-Device-Token': 'must-not-forward' }), options(async (url, init) => {
    calls++;
    assert.equal(url, target);
    assert.equal(init.method, 'PUT');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' });
    assert.deepEqual([...init.body], [255,216,1,255,217]);
    return new Response('{}');
  }));
  assert.equal(r.status, 200); assert.equal(calls, 1);
  assert.equal((await r.json()).ok, true);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('missing, forged, changed, wrong-key and expired capabilities never upload', async () => {
  const original = grant();
  const [payload, mac] = original.split('.');
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload,'base64url')), url: 'https://evil.invalid' })).toString('base64url') + '.' + mac;
  for (const token of ['', 'fake.fake', changed, grant(Date.now() - 1800001), original + '.extra']) {
    const r = await relayImageUpload(request(token), options(async () => { assert.fail('must not reach storage'); }));
    assert.equal(r.status, 403);
  }
  assert.equal((await relayImageUpload(request(), { ...options(async () => assert.fail()), secret:'other-key' })).status, 403);
});

test('grant refuses arbitrary targets, path traversal, other buckets and unsafe MIME', () => {
  for (const url of [target.replace(storageOrigin, 'https://evil.invalid'), target.replace('/sku-raw/', '/private/'), target.replace('https:', 'http:'), target.replace('/2026-10-04/', '/../'), target.replace('?token=', '?other=')]) {
    assert.throws(() => createUploadRelayGrant(url, 'image/jpeg', secret, storageOrigin));
  }
  assert.throws(() => createUploadRelayGrant(target, 'text/html', secret, storageOrigin));
});

test('empty and oversized uploads are rejected before storage, even without content-length', async () => {
  for (const [body, headers, status] of [
    [new Uint8Array(), {}, 400],
    [new Uint8Array([1]), {'Content-Length':String(12*1024*1024+1)}, 413],
    [new Uint8Array(12*1024*1024+1), {}, 413],
  ]) {
    const r = await relayImageUpload(request(grant(), body, headers), options(async () => assert.fail('no upload')));
    assert.equal(r.status, status);
  }
});

test('storage failure is not backup success and no secret body is returned', async () => {
  for (const status of [400,403,409,500,503]) {
    const r = await relayImageUpload(request(), options(async () => new Response('secret-upstream-body', {status})));
    assert.equal(r.status, status >= 500 ? 502 : status);
    const text = await r.text();
    assert.ok(!text.includes('secret')); assert.ok(!text.includes('https://'));
    assert.equal(JSON.parse(text).ok, false);
  }
});

test('timeout does not blindly replay a non-upsert write', async () => {
  let calls = 0;
  const r = await relayImageUpload(request(), options(async () => { calls++; throw new Error('signed URL secret'); }));
  assert.equal(r.status, 504); assert.equal(calls, 1);
  assert.ok(!(await r.text()).includes('secret'));
});
