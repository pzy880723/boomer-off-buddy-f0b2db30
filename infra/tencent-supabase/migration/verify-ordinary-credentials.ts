// Read-only connectivity probe. Does not create, close, pay or refund an order.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { createWeChatPayClient } from '../../../src/server/wechat-ordinary-client';

async function main() {
  const [zipPath, publicKeyPath, apiKeyPath, merchantId, appId, publicKeyId] = process.argv.slice(2);
  if (![zipPath, publicKeyPath, apiKeyPath, merchantId, appId, publicKeyId].every(Boolean)) throw new Error('Six configuration arguments required');
  const certificate = new X509Certificate(execFileSync('unzip', ['-p', zipPath, 'apiclient_cert.pem']));
  const privateKey = createPrivateKey(execFileSync('unzip', ['-p', zipPath, 'apiclient_key.pem']));
  if (!certificate.checkPrivateKey(privateKey) || !certificate.subject.split('\n').includes(`CN=${merchantId}`)) throw new Error('Certificate identity mismatch');
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) throw new Error('Certificate outside validity period');
  const client = createWeChatPayClient({ merchantId, appId, privateKey, certificateSerial: certificate.serialNumber,
    wechatPublicKey: createPublicKey(readFileSync(publicKeyPath)), wechatPublicKeyId: publicKeyId,
    apiV3Key: readFileSync(apiKeyPath, 'utf8').replace(/\r?\n$/, ''),
    notifyUrl: 'https://erp.boomeroff.com/api/public/storefront/payments/wechat-notify',
    refundNotifyUrl: 'https://erp.boomeroff.com/api/public/storefront/payments/wechat-notify' });
  try { await client.queryPayment('BOOMERREADONLY20260908'); }
  catch (error) {
    if ((error as { code?: string }).code === 'ORDER_NOT_EXIST') {
      console.log(JSON.stringify({ certificateMatchesMerchant: true, signedReadOnlyQueryVerified: true, orderCreated: false }));
      return;
    }
    // Only safe protocol codes. Never log provider details or credential values.
    console.error(JSON.stringify({ signedReadOnlyQueryVerified: false,
      code: (error as { code?: string }).code ?? 'verification_failed' }));
    process.exitCode = 1;
    return;
  }
  throw new Error('Probe order unexpectedly exists');
}
main().catch(() => { console.error('Credential probe failed validation'); process.exitCode = 1; });
