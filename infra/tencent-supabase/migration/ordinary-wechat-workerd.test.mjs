import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomBytes, sign, createCipheriv, verify } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('Tencent workerd supports ordinary payment RSA signing, verification and AES callbacks', async () => {
  // Ephemeral fixtures only. Never connects to WeChat or the production ledger.
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const apiKey = randomBytes(16).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  function headers(raw) {
    return { 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': 'fixture',
      'Wechatpay-Serial': 'PUB_KEY_ID_TEST',
      'Wechatpay-Signature': sign('RSA-SHA256', Buffer.from(`${timestamp}\nfixture\n${raw}\n`), platform.privateKey).toString('base64') };
  }
  const responseRaw = JSON.stringify({ prepay_id: 'fixture-prepay' });
  const nonce = '123456789012';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiKey), Buffer.from(nonce));
  cipher.setAAD(Buffer.from('transaction'));
  const transaction = { mchid: '1234567890', appid: 'wx-test', out_trade_no: 'BO202609080001',
    transaction_id: 'fixture-transaction', trade_state: 'SUCCESS', amount: { total: 100, currency: 'CNY' } };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const raw = JSON.stringify({ id: 'fixture-event', event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource',
    resource: { original_type: 'transaction', algorithm: 'AEAD_AES_256_GCM', nonce, associated_data: 'transaction', ciphertext } });
  const bundle = await build({ write: false, bundle: true, format: 'esm', platform: 'neutral', external: ['node:crypto'],
    stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
      import { createWeChatPayClient } from './src/server/wechat-ordinary-client';
      export default { async fetch(request, env) {
        const fixture = await request.json();
        const client = createWeChatPayClient({ appId: 'wx-test', merchantId: '1234567890', certificateSerial: 'ABC123',
          privateKey: env.PRIVATE_KEY, wechatPublicKey: env.PUBLIC_KEY, apiV3Key: env.API_KEY,
          wechatPublicKeyId: 'PUB_KEY_ID_TEST', notifyUrl: 'https://example.com/notify', refundNotifyUrl: 'https://example.com/notify',
          fetchImpl: async () => new Response(fixture.responseRaw, { headers: fixture.responseHeaders }) });
        const result = await client.createPayment({ orderNo: 'BO202609080001', totalFen: 100, openid: 'fixture-openid', description: 'fixture' });
        const event = client.decodeNotification(fixture.raw, fixture.headers);
        return Response.json({ result, event });
      } };` } });
  const runtime = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-09-24', compatibilityFlags: ['nodejs_compat'],
    bindings: { PRIVATE_KEY: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      PUBLIC_KEY: platform.publicKey.export({ type: 'spki', format: 'pem' }), API_KEY: apiKey } });
  try {
    const response = await runtime.dispatchFetch('https://fixture.test', { method: 'POST',
      body: JSON.stringify({ responseRaw, responseHeaders: headers(responseRaw), raw, headers: headers(raw) }) });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.event.data.transaction_id, transaction.transaction_id);
    const p = body.result.payment_payload;
    assert.ok(verify('RSA-SHA256', Buffer.from(`wx-test\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`), merchant.publicKey, Buffer.from(p.paySign, 'base64')));
  } finally { await runtime.dispose(); }
});
