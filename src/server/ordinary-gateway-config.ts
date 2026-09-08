type Environment = Record<string, string | undefined>;

export interface OrdinaryGatewayConfig {
  url: string;
  token: string;
  eventSecret: string;
  timeoutMs: number;
}

/**
 * 腾讯云普通商户支付网关。私钥 / APIv3 密钥只存在于网关侧，ERP 只持有
 * 调用凭据（token）与内部事件签名密钥，绝不落地微信商户密钥。
 */
export function ordinaryGatewayConfig(env: Environment): OrdinaryGatewayConfig | null {
  const rawUrl = env["ORDINARY_PAYMENT_GATEWAY_URL"]?.trim();
  const token = env["ORDINARY_PAYMENT_GATEWAY_TOKEN"]?.trim();
  const eventSecret = env["ORDINARY_PAYMENT_GATEWAY_EVENT_SECRET"]?.trim();
  if (!rawUrl && !token && !eventSecret) return null;
  if (!rawUrl || !token || !eventSecret)
    throw new Error("Ordinary payment gateway configuration incomplete");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Ordinary payment gateway URL invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Ordinary payment gateway requires a fixed https URL");
  if (token.length < 24 || eventSecret.length < 24)
    throw new Error("Ordinary payment gateway credentials too weak");
  const timeoutRaw = Number(env["ORDINARY_PAYMENT_GATEWAY_TIMEOUT_MS"] ?? 8000);
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.min(Math.max(timeoutRaw, 2000), 20000)
    : 8000;
  return { url: url.toString().replace(/\/+$/, ""), token, eventSecret, timeoutMs };
}
