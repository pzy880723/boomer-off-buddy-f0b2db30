import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { GoScopeError } from '../lib/go-bridge/scope.ts';

const files = ['go-authorization.server.ts', 'go-bridge.server.ts'];
const key = 'sb_publishable_local_test_only';
const jwt = 'local.test.user-jwt';
const clean = text => stripTypeScriptTypes(text.replace(/^import[\s\S]*?;\n/gm, '').replaceAll('export ', ''));

function client(file, origin, userToken, fetchImpl = fetch, timerApi = {}) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  const start = src.indexOf('function goClient(');
  const end = src.indexOf('\n}', start) + 2;
  const context = {
    GO_SUPABASE_ORIGIN: origin, GO_FETCH_TIMEOUT_MS: 8000, GoScopeError,
    Request, Response, URL, Headers, AbortController, AbortSignal, DOMException,
    fetch: fetchImpl, clearTimeout, setTimeout,
    createClient: (_url, _key, options) => options.global.fetch,
    ...timerApi,
  };
  const helper = new URL('trusted-go-fetch.server.ts', import.meta.url);
  if (existsSync(helper)) {
    context.createTrustedGoFetch = vm.runInNewContext(`${clean(readFileSync(helper, 'utf8'))}\ncreateTrustedGoFetch`, context);
  }
  return vm.runInNewContext(`${clean(src.slice(start, end))}\ngoClient`, context)({ url: origin, publishableKey: key }, userToken);
}

async function withServer(run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/redirect-target' }); res.end(); return;
    }
    if (req.url === '/slow-body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders(); res.write('{"pending":'); return;
    }
    if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
    if (req.url === '/auth/v1/user') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Upstream': 'preserved' });
    res.end(JSON.stringify({ method: req.method, body, authorization: req.headers.authorization,
      apikey: req.headers.apikey, custom: req.headers['x-client-info'] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

for (const file of files) {
  test(`${file}: cross-origin string/URL/Request is rejected before fetch`, async () => {
    let calls = 0;
    const run = client(file, 'https://trusted.test', jwt, async () => { calls++; return Response.json({}); });
    for (const input of ['https://other.test/rpc', new URL('https://other.test/rpc'), new Request('https://other.test/rpc')]) {
      await assert.rejects(run(input), e => e.code === 'go_origin_invalid');
    }
    assert.equal(calls, 0);
  });

  for (const shape of ['string', 'URL', 'Request']) test(`${file}: ${shape} preserves user JWT, body and Supabase JSON`, async () => {
    await withServer(async origin => {
      const run = client(file, origin);
      const init = { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'X-Client-Info': 'test-client' }, body: '{"id":"local"}' };
      const input = shape === 'Request' ? new Request(`${origin}/rpc`, init) : shape === 'URL' ? new URL(`${origin}/rpc`) : `${origin}/rpc`;
      const response = await run(input, shape === 'Request' ? undefined : init);
      assert.equal(response.headers.get('x-upstream'), 'preserved');
      assert.deepEqual(await response.json(), { method: 'POST', body: init.body, authorization: `Bearer ${jwt}`, apikey: key, custom: 'test-client' });
    });
  });

  test(`${file}: explicit user token wins; publishable key is never used as a replacement JWT`, async () => {
    let sent;
    const fake = async (input, init) => { sent = new Request(input, init); return Response.json({}); };
    await client(file, 'https://trusted.test', jwt, fake)('https://trusted.test/rpc', { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(sent.headers.get('authorization'), `Bearer ${jwt}`);
    assert.equal(sent.headers.get('apikey'), key);
    await client(file, 'https://trusted.test', undefined, fake)('https://trusted.test/auth/v1/user', { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(sent.headers.has('authorization'), false);
  });

  test(`${file}: actual Supabase SDK can verify user and parse RPC JSON without replacing JWT`, async () => {
    await withServer(async origin => {
      let sentAuthorization;
      const transport = async (input, init) => {
        sentAuthorization = new Headers(init?.headers ?? input.headers).get('authorization');
        return fetch(input, init);
      };
      const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
      const identityClient = createSupabaseClient(origin, key, { auth, global: { fetch: client(file, origin, undefined, transport) } });
      const user = await identityClient.auth.getUser(jwt);
      assert.equal(user.error, null);
      assert.equal(user.data.user.id, '00000000-0000-4000-8000-000000000001');
      assert.equal(sentAuthorization, `Bearer ${jwt}`);
      const rpcClient = createSupabaseClient(origin, key, { auth, global: { fetch: client(file, origin, jwt, transport) } });
      const rpc = await rpcClient.rpc('erp_verify_current_scope_v1');
      assert.equal(rpc.error, null);
      assert.equal(rpc.data.authorization, `Bearer ${jwt}`);
      assert.equal(rpc.data.apikey, key);
    });
  });

  test(`${file}: real HTTP redirect is never followed`, async () => {
    await withServer(async (origin, requests) => {
      await assert.rejects(client(file, origin, jwt)(`${origin}/redirect`));
      assert.deepEqual(requests, ['/redirect']);
    });
  });

  test(`${file}: real HTTP headers do not end the body deadline`, async () => {
    await withServer(async origin => {
      let guard;
      let headersReceived = false;
      let fireDeadline;
      let timerActive = false;
      const timerApi = {
        setTimeout(fn, ms) { assert.equal(ms, 8000); timerActive = true; fireDeadline = () => { if (timerActive) fn(); }; return 1; },
        clearTimeout() { timerActive = false; },
      };
      const transport = async (input, init) => {
        const response = await fetch(input, init);
        headersReceived = true;
        setTimeout(() => fireDeadline(), 10);
        return response;
      };
      try {
        const outcome = await Promise.race([
          client(file, origin, jwt, transport, timerApi)(`${origin}/slow-body`).then(() => 'resolved', () => 'rejected'),
          new Promise(resolve => { guard = setTimeout(() => resolve('body deadline missing'), 5000); }),
        ]);
        assert.equal(outcome, 'rejected');
        assert.equal(headersReceived, true, 'timeout must cover body after successful response headers');
      } finally { clearTimeout(guard); }
    });
  });

  test(`${file}: external abort also cancels an unfinished real HTTP body`, async () => {
    await withServer(async origin => {
      const controller = new AbortController();
      const reason = new Error('caller stopped body read');
      const transport = async (input, init) => {
        const response = await fetch(input, init);
        queueMicrotask(() => controller.abort(reason));
        return response;
      };
      await assert.rejects(client(file, origin, jwt, transport)(`${origin}/slow-body`, { signal: controller.signal }), e => e === reason);
    });
  });

  test(`${file}: real HTTP 204 remains a valid empty response`, async () => {
    await withServer(async origin => {
      const response = await client(file, origin, jwt)(`${origin}/empty`);
      assert.equal(response.status, 204);
      assert.equal(await response.text(), '');
    });
  });

  for (const useRequest of [false, true]) test(`${file}: caller abort from ${useRequest ? 'Request' : 'init'} reaches transport with its reason`, async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const run = client(file, 'https://trusted.test', jwt, (input, init) => new Promise((resolve, reject) => {
      const signal = init?.signal ?? input.signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const input = useRequest ? new Request('https://trusted.test/rpc', { signal: controller.signal }) : 'https://trusted.test/rpc';
    const pending = run(input, useRequest ? undefined : { signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending, e => e === reason);
  });

  test(`${file}: already-aborted caller does not start fetch`, async () => {
    const controller = new AbortController();
    const reason = new Error('already cancelled'); controller.abort(reason);
    let calls = 0;
    const run = client(file, 'https://trusted.test', jwt, async () => { calls++; return Response.json({}); });
    await assert.rejects(run('https://trusted.test/rpc', { signal: controller.signal }), e => e === reason);
    assert.equal(calls, 0);
  });

  test(`${file}: requests force no-store and cannot opt into redirects`, async () => {
    let options;
    await client(file, 'https://trusted.test', jwt, async (_input, init) => { options = init; return Response.json({}); })('https://trusted.test/rpc', { redirect: 'follow', cache: 'force-cache' });
    assert.ok(['manual', 'error'].includes(options.redirect));
    assert.equal(options.cache, 'no-store');
    assert.equal(new Headers(options.headers).get('cache-control'), 'no-store');
  });

  test(`${file}: JSON success and errors are no-store`, () => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const name = file.startsWith('go-authorization') ? 'authzJson' : 'goJson';
    const start = src.indexOf(`export function ${name}(`);
    const code = src.slice(start, src.indexOf('\n}', start) + 2);
    const json = vm.runInNewContext(`${clean(code)}\n${name}`, { Response, GO_AUTHZ_CORS: {}, GO_CORS: {} });
    for (const status of [200, 401, 403, 503]) assert.equal(json({ ok: status === 200 }, status).headers.get('cache-control'), 'no-store');
  });
}
