import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ordinaryPaymentPolicy, ordinaryPaymentSecrets } from './ordinary-payment-config';
const env = { STOREFRONT_PAYMENT_MODE: 'ordinary_wechat', WECHAT_ORDINARY_MCH_ID: '1749999844',
  WECHAT_ORDINARY_APP_ID: 'wx9aef0738067286b3', WECHAT_ORDINARY_OWNED_LOCATION_IDS: '12345678-1234-1234-1234-123456789012',
  WECHAT_ORDINARY_NOTIFY_URL: 'https://erp.boomeroff.com/api/public/storefront/payments/wechat-notify' };
test('default leaves existing split mode unchanged and disabled ordinary mode does not need credentials', () => {
  assert.equal(ordinaryPaymentPolicy({}).mode, 'legacy');
});
test('runtime credentials use server secret bindings, not inaccessible host filesystem paths', () => {
  const secrets = { WECHAT_ORDINARY_PRIVATE_KEY_BASE64: Buffer.from('test-private-pem').toString('base64'),
    WECHAT_ORDINARY_PUBLIC_KEY_BASE64: Buffer.from('test-public-pem').toString('base64'),
    WECHAT_ORDINARY_API_V3_KEY: 'a'.repeat(32), WECHAT_ORDINARY_CERT_SERIAL: 'ABC123', WECHAT_ORDINARY_PUBLIC_KEY_ID: 'PUB_KEY_ID_TEST' };
  const config = ordinaryPaymentSecrets(secrets);
  assert.equal(config.privateKey.toString(), 'test-private-pem'); assert.equal(config.apiV3Key, 'a'.repeat(32));
  assert.throws(() => ordinaryPaymentSecrets({ WECHAT_ORDINARY_PRIVATE_KEY_FILE: '/host/key.pem' }), /credentials/i);
  assert.throws(() => ordinaryPaymentSecrets({ ...secrets, WECHAT_ORDINARY_API_V3_KEY: 'short' }), /credentials/i);
});
test('ordinary requires explicit verified self-owned store list and fixed HTTPS callback', () => {
  const policy = ordinaryPaymentPolicy(env);
  assert.equal(policy.mode, 'ordinary_wechat'); assert.equal(policy.merchantId, '1749999844');
  assert.deepEqual(policy.ownedLocationIds, ['12345678-1234-1234-1234-123456789012']);
  for (const change of [{ WECHAT_ORDINARY_OWNED_LOCATION_IDS: '' }, { WECHAT_ORDINARY_MCH_ID: '' },
    { WECHAT_ORDINARY_NOTIFY_URL: 'http://localhost/callback' }, { STOREFRONT_PAYMENT_MODE: 'typo' }])
    assert.throws(() => ordinaryPaymentPolicy({ ...env, ...change }), /config|mode|https|location/i);
});
