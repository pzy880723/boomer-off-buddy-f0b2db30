import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { consumerAuthEnvironment, verifyConsumerJwt } from "@/server/consumer-auth.server";

export const STOREFRONT_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

export function storefrontJson(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...STOREFRONT_CORS,
      ...(init.headers || {}),
    },
  });
}

export function storefrontError(message: string, status = 400, code?: string) {
  return storefrontJson({ ok: false, error: message, ...(code ? { code } : {}) }, { status });
}

export async function authenticateStorefrontCustomer(request: Request): Promise<
  | {
      ok: true;
      customer: {
        id: string;
        externalSubject: string;
        phone: string | null;
        nickname: string | null;
      };
    }
  | { ok: false; response: Response }
> {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, response: storefrontError("Authentication required", 401) };
  const config = consumerAuthEnvironment();
  if (!config) {
    return {
      ok: false,
      response: storefrontError("Consumer authentication is not configured", 503),
    };
  }

  let identity;
  try {
    identity = await verifyConsumerJwt(token, config);
  } catch {
    return { ok: false, response: storefrontError("Invalid consumer session", 401) };
  }

  const { data, error } = await supabaseAdmin
    .from("commerce_customers" as never)
    .upsert(
      {
        external_subject: identity.subject,
        phone: identity.phone,
        wechat_openid: identity.wechatOpenId,
        wechat_unionid: identity.wechatUnionId,
        nickname: identity.nickname,
        avatar_url: identity.avatarUrl,
        last_login_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "external_subject" },
    )
    .select("id,external_subject,phone,nickname,status")
    .single();
  if (error || !data) {
    return {
      ok: false,
      response: storefrontError(error?.message ?? "Consumer profile unavailable", 500),
    };
  }
  const customer = data as unknown as {
    id: string;
    external_subject: string;
    phone: string | null;
    nickname: string | null;
    status: string;
  };
  if (customer.status !== "active") {
    return { ok: false, response: storefrontError("Consumer account is unavailable", 403) };
  }

  const identities = [
    identity.phone ? { provider: "phone", provider_subject: identity.phone } : null,
    identity.wechatUnionId || identity.wechatOpenId
      ? {
          provider: "wechat",
          provider_subject: identity.wechatUnionId ?? identity.wechatOpenId!,
        }
      : null,
  ].filter(Boolean) as Array<{ provider: string; provider_subject: string }>;
  if (identities.length > 0) {
    const { error: identityError } = await supabaseAdmin
      .from("commerce_customer_identities" as never)
      .upsert(identities.map((item) => ({ ...item, customer_id: customer.id })) as never, {
        onConflict: "provider,provider_subject",
      });
    if (identityError) return { ok: false, response: storefrontError(identityError.message, 500) };
  }

  return {
    ok: true,
    customer: {
      id: customer.id,
      externalSubject: customer.external_subject,
      phone: customer.phone,
      nickname: customer.nickname,
    },
  };
}
