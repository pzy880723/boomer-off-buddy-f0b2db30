import { webcrypto } from "node:crypto";

export type ConsumerIdentity = {
  subject: string;
  phone: string | null;
  wechatOpenId: string | null;
  wechatUnionId: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  providers: Array<"phone" | "wechat">;
};

type ConsumerJwtConfig = {
  issuer: string;
  audience: string;
  jwks: () => Promise<{ keys: Array<JsonWebKey & { kid?: string }> }>;
};

type JwtPayload = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  phone?: string;
  wechat_openid?: string;
  wechat_unionid?: string;
  nickname?: string;
  avatar_url?: string;
  providers?: string[];
};

function decodePart<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function acceptsAudience(actual: string | string[] | undefined, expected: string) {
  return typeof actual === "string" ? actual === expected : actual?.includes(expected) === true;
}

export async function verifyConsumerJwt(
  token: string,
  config: ConsumerJwtConfig,
): Promise<ConsumerIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid consumer token");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodePart<{ alg?: string; kid?: string }>(encodedHeader);
  const payload = decodePart<JwtPayload>(encodedPayload);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported token algorithm");

  const { keys } = await config.jwks();
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new Error("Unknown token signing key");
  const cryptoApi = globalThis.crypto ?? webcrypto;
  const key = await cryptoApi.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await cryptoApi.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(encodedSignature, "base64url"),
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new Error("Invalid token signature");

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== config.issuer) throw new Error("Invalid token issuer");
  if (!acceptsAudience(payload.aud, config.audience)) throw new Error("Invalid token audience");
  if (!payload.sub) throw new Error("Consumer subject is required");
  if (!payload.exp || payload.exp <= now) throw new Error("Consumer token expired");
  if (payload.nbf && payload.nbf > now + 30) throw new Error("Consumer token is not active");

  const providers = (payload.providers ?? []).filter(
    (provider): provider is "phone" | "wechat" => provider === "phone" || provider === "wechat",
  );
  return {
    subject: payload.sub,
    phone: payload.phone ?? null,
    wechatOpenId: payload.wechat_openid ?? null,
    wechatUnionId: payload.wechat_unionid ?? null,
    nickname: payload.nickname ?? null,
    avatarUrl: payload.avatar_url ?? null,
    providers,
  };
}

let cachedJwks: {
  expiresAt: number;
  value: { keys: Array<JsonWebKey & { kid?: string }> };
} | null = null;

export function consumerAuthEnvironment() {
  const issuer = process.env.CONSUMER_AUTH_ISSUER?.trim();
  const audience = process.env.CONSUMER_AUTH_AUDIENCE?.trim();
  const jwksUrl = process.env.CONSUMER_AUTH_JWKS_URL?.trim();
  if (!issuer || !audience || !jwksUrl) return null;
  return {
    issuer,
    audience,
    jwks: async () => {
      if (cachedJwks && cachedJwks.expiresAt > Date.now()) return cachedJwks.value;
      const response = await fetch(jwksUrl, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Consumer JWKS unavailable (${response.status})`);
      const value = (await response.json()) as { keys: JsonWebKey[] };
      if (!Array.isArray(value.keys)) throw new Error("Invalid consumer JWKS");
      cachedJwks = { value, expiresAt: Date.now() + 5 * 60_000 };
      return value;
    },
  };
}
