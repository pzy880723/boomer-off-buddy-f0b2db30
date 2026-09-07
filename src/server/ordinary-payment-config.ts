type Environment = Record<string, string | undefined>;
export function ordinaryPaymentSecrets(env: Environment) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error('Ordinary payment credentials are not configured');
    return value;
  };
  const decode = (name: string) => {
    const value = required(name);
    if (value.length > 16000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid payment credentials');
    return Buffer.from(value, 'base64');
  };
  const apiV3Key = required('WECHAT_ORDINARY_API_V3_KEY');
  if (Buffer.byteLength(apiV3Key) !== 32) throw new Error('Invalid APIv3 credentials');
  return { privateKey: decode('WECHAT_ORDINARY_PRIVATE_KEY_BASE64'), wechatPublicKey: decode('WECHAT_ORDINARY_PUBLIC_KEY_BASE64'),
    apiV3Key, certificateSerial: required('WECHAT_ORDINARY_CERT_SERIAL'), wechatPublicKeyId: required('WECHAT_ORDINARY_PUBLIC_KEY_ID') };
}
export function ordinaryMerchantConfig(env: Environment) {
  const merchantId = env.WECHAT_ORDINARY_MCH_ID?.trim() ?? '';
  const appId = env.WECHAT_ORDINARY_APP_ID?.trim() ?? '';
  if (!/^\d{6,20}$/.test(merchantId) || !/^wx[a-zA-Z0-9]{16}$/.test(appId)) throw new Error('Ordinary merchant configuration missing');
  const notifyUrl = env.WECHAT_ORDINARY_NOTIFY_URL?.trim() ?? '';
  const url = new URL(notifyUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw new Error('Ordinary callback requires fixed https URL');
  return { merchantId, appId, notifyUrl };
}
export function ordinaryPaymentPolicy(env: Environment) {
  const mode = env.STOREFRONT_PAYMENT_MODE?.trim() || 'legacy';
  if (mode === 'legacy') return { mode: 'legacy' as const };
  if (mode !== 'ordinary_wechat') throw new Error('Unknown storefront payment mode');
  const settings = ordinaryMerchantConfig(env);
  const ownedLocationIds = [...new Set((env.WECHAT_ORDINARY_OWNED_LOCATION_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean))];
  if (!ownedLocationIds.length || ownedLocationIds.some(id => !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)))
    throw new Error('Verified owned location configuration required');
  return { mode: 'ordinary_wechat' as const, ...settings, ownedLocationIds };
}
