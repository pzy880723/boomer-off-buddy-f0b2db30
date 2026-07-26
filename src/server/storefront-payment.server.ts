const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(buffer: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyPaymentSignature(rawBody: string, signature: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const normalized = signature.trim().replace(/^sha256=/i, "");
  return (
    constantTimeEqual(normalized.toLowerCase(), toHex(digest)) ||
    constantTimeEqual(normalized, toBase64(digest))
  );
}

export function storefrontPaymentGatewayConfig() {
  const url = process.env.STOREFRONT_PAYMENT_GATEWAY_URL?.replace(/\/+$/, "");
  const token = process.env.STOREFRONT_PAYMENT_GATEWAY_TOKEN;
  const webhookSecret = process.env.STOREFRONT_PAYMENT_WEBHOOK_SECRET;
  return {
    url: url || null,
    token: token || null,
    webhookSecret: webhookSecret || null,
    configured: Boolean(url && token && webhookSecret),
  };
}
