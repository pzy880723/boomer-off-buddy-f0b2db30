// App Store review demo isolation. Plain JS so the Tencent start script can run it
// before the server boots (node without TS support) and the app can import it too.
// Only active when BOOMER_REVIEW_ISOLATED=true; production behaviour is unchanged.

export const REVIEW_FLAG = "BOOMER_REVIEW_ISOLATED";
export const REVIEW_TOKEN_PREFIX = "rvw_";
export const REVIEW_ENVIRONMENT = "demo";

// Hosts/refs of real data stores the demo must never point at.
export const PRODUCTION_DATA_MARKERS = ["sxddfcoiaboqcmeviykl", "data.boomeroff.top"];

// Any non-empty value means a real external channel is configured.
export const FORBIDDEN_CHANNEL_ENV = [
  "YOUZAN_CLIENT_ID", "YOUZAN_CLIENT_SECRET", "YOUZAN_PROXY_URL", "YOUZAN_PROXY_TOKEN",
  "YOUZAN_MEMBER_LINK_DB", "YOUZAN_POINTS_WRITE_CUSTOMER_IDS",
  "WECHAT_PAY_MCHID", "WECHAT_PAY_APPID", "WECHAT_PAY_PRIVATE_KEY", "WECHAT_PAY_APIV3_KEY",
  "WECHAT_PAY_SERIAL_NO", "WECHAT_PAY_PLATFORM_PUBLIC_KEY", "WECHAT_PAY_NOTIFY_URL",
  "WECHAT_ORDINARY_RECONCILE_TOKEN",
  "ALIPAY_APP_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY", "ALIPAY_GATEWAY_URL", "ALIPAY_NOTIFY_URL",
  "STOREFRONT_PAYMENT_GATEWAY_URL", "STOREFRONT_PAYMENT_GATEWAY_TOKEN", "STOREFRONT_PAYMENT_WEBHOOK_SECRET",
  "TENCENT_SMS_SDK_APP_ID", "TENCENT_SMS_SIGN_NAME", "TENCENT_SMS_TEMPLATE_ID",
  "TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY",
  "TENCENT_MEDIA_URL", "TENCENT_MEDIA_SERVICE_ROLE_KEY",
  "GO_SUPABASE_URL", "GO_SUPABASE_ANON_KEY", "GO_SUPABASE_PUBLISHABLE_KEY",
];

// Background writers that must stay off (anything other than empty/false is refused).
export const FORBIDDEN_TRUE_FLAGS = [
  "HANDHELD_RELEASE_WORKER_ENABLED", "HANDHELD_ITEM_SYNC_WORKER_ENABLED",
  "YOUZAN_STOCK_WORKER_ENABLED", "YOUZAN_IMAGE_REFRESH_WORKER_ENABLED",
  "YOUZAN_ORDER_SYNC_WORKER_ENABLED", "YOUZAN_SALE_COMPENSATION_ENABLED",
  "YOUZAN_POINTS_WRITE_ENABLED", "CHANNEL_SYNC_WORKER_ENABLED",
];

export const REQUIRED_ISOLATED_ENV = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];

/** @param {Record<string, string | undefined>} env */
export function isReviewIsolated(env = process.env) {
  return String(env[REVIEW_FLAG] ?? "").trim().toLowerCase() === "true";
}

/**
 * Returns violation codes (names only, never values). Empty array = safe to run.
 * @param {Record<string, string | undefined>} env
 */
export function reviewIsolationViolations(env = process.env) {
  if (!isReviewIsolated(env)) return [];
  const out = [];
  const val = (k) => String(env[k] ?? "").trim();
  for (const k of REQUIRED_ISOLATED_ENV) if (!val(k)) out.push(`missing:${k}`);
  for (const k of ["SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_PROJECT_ID", "VITE_SUPABASE_PROJECT_ID"]) {
    const v = val(k).toLowerCase();
    if (v && PRODUCTION_DATA_MARKERS.some((m) => v.includes(m))) out.push(`production_data:${k}`);
  }
  const url = val("SUPABASE_URL"), vite = val("VITE_SUPABASE_URL");
  if (url && vite && new URL(url).host !== new URL(vite).host && !/^(localhost|127\.0\.0\.1)/.test(new URL(url).host)) {
    out.push("mismatch:VITE_SUPABASE_URL");
  }
  for (const k of FORBIDDEN_CHANNEL_ENV) if (val(k)) out.push(`external_channel:${k}`);
  for (const k of FORBIDDEN_TRUE_FLAGS) {
    const v = val(k).toLowerCase();
    if (v && v !== "false" && v !== "0") out.push(`worker_enabled:${k}`);
  }
  const mode = val("STOREFRONT_PAYMENT_MODE").toLowerCase();
  if (mode && mode !== "disabled" && mode !== "off") out.push("external_channel:STOREFRONT_PAYMENT_MODE");
  return out;
}

export class ReviewIsolationError extends Error {
  /** @param {string[]} violations */
  constructor(violations) {
    super(`review_isolation_violation: ${violations.join(", ")}`);
    this.name = "ReviewIsolationError";
    this.code = "review_isolation_violation";
    this.violations = violations;
  }
}

/** Throws when the demo instance is misconfigured. No-op in production. */
export function assertReviewIsolation(env = process.env) {
  const v = reviewIsolationViolations(env);
  if (v.length) throw new ReviewIsolationError(v);
}

/** Demo instances must never perform real external writes (Youzan, payment, SMS, customer channels). */
export function assertNoExternalWrite(channel, env = process.env) {
  if (isReviewIsolated(env)) throw new ReviewIsolationError([`external_write_blocked:${channel}`]);
}

export function genReviewDeviceToken() {
  const bytes = new Uint8Array(30);
  crypto.getRandomValues(bytes);
  return REVIEW_TOKEN_PREFIX + Buffer.from(bytes).toString("base64url");
}
