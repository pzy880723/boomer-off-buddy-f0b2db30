/**
 * GO ← ERP 授权刷新通道（服务端专用）。
 *
 * 与 `authenticateGoActor` 的区别（关键）：
 *  - 这里**只做身份核验**（固定 GO issuer 的 auth.getUser + 无参可信 RPC 取 canonical erp_user_id），
 *    不做 scope / 排班 / 撤销镜像 / 日期一致性判定。
 *    授权刷新绝不能因为 GO 旧 scope、租约过期、休息、已撤销镜像而被挡住，
 *    否则会形成 scope_stale 死循环，GO 永远拿不到新授权。
 *  - 不新增、不传输任何后台密钥：GO 只用「用户本人的 JWT」调用本接口。
 *  - 不接受任何客户端传入的 ERP ID，不按姓名 / 手机号关联。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { GO_PROJECT_REF, GO_SUPABASE_ORIGIN } from "@/lib/go-bridge/constants";
import { GoScopeError } from "@/lib/go-bridge/scope";
import {
  buildAuthorizationSnapshot,
  expectedLinkStatus,
  parseGoReceiptPayload,
  GoReceiptError,
  PERMISSION_MODEL_REV,
  type AuthorizationFacts,
  type AuthorizationSnapshot,
} from "@/lib/go-bridge/authorization";


export { GoReceiptError };

/** GO 侧无参可信身份/范围函数 */
export const GO_SCOPE_RPC = "erp_verify_current_scope_v1";
/** GO 侧无参可信镜像回执函数 */
export const GO_RECEIPT_RPC = "erp_scope_sync_receipt_v1";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type GoEnv = { url: string; publishableKey: string; projectRef: string };

function goEnvironment(): GoEnv | null {
  const url = process.env["GO_SUPABASE_URL"]?.trim();
  const publishableKey =
    process.env["GO_SUPABASE_PUBLISHABLE_KEY"]?.trim() ||
    process.env["GO_SUPABASE_ANON_KEY"]?.trim();
  if (!url || !publishableKey) return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  // 必须整体等于固定 GO origin，绝不用 includes 子串判断
  if (origin !== GO_SUPABASE_ORIGIN) return null;
  return { url: origin, publishableKey, projectRef: GO_PROJECT_REF };
}

/** GO 调用超时（含完整 body 读取），避免长挂 */
export const GO_FETCH_TIMEOUT_MS = 8_000;

function goClient(env: GoEnv, userToken?: string): SupabaseClient {
  const key = env.publishableKey;
  return createClient(env.url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : (input as Request).url);
        // 固定 origin：绝不把用户 token 发到别处
        if (url.origin !== GO_SUPABASE_ORIGIN) {
          throw new GoScopeError("go_origin_invalid", "GO 请求地址不合法", 502);
        }
        const headers = new Headers(init?.headers);
        headers.set("apikey", key);
        headers.set("cache-control", "no-store");
        if (userToken) headers.set("Authorization", `Bearer ${userToken}`);
        else if (key.startsWith("sb_")) headers.delete("Authorization");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), GO_FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(url.toString(), {
            ...init,
            headers,
            // 禁止重定向：避免 token 被跟随到其它地址
            redirect: "manual",
            cache: "no-store",
            signal: controller.signal,
          });
          if (res.status >= 300 && res.status < 400) {
            throw new GoScopeError("go_redirect_blocked", "GO 返回了重定向，已阻断", 502);
          }
          // 完整读取 body 后再放行，超时窗口覆盖 body
          const body = await res.text();
          return new Response(body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        } finally {
          clearTimeout(timer);
        }
      },
    },
  });
}


function bearerToken(request: Request): string | null {
  const raw = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

export type GoIdentity = {
  goUserId: string;
  erpUserId: string;
  token: string;
  env: GoEnv;
};

/**
 * 只核验身份：固定 GO issuer 实际 auth.getUser(token) + 无参可信 RPC 拿唯一 canonical erp_user_id。
 * 不解析 scope_context / shop_context 的排班状态，不因旧上下文阻断刷新。
 */
export async function authenticateGoIdentity(request: Request): Promise<GoIdentity> {
  const env = goEnvironment();
  if (!env) throw new GoScopeError("go_bridge_not_configured", "GO 桥接尚未配置", 503);

  const token = bearerToken(request);
  if (!token) throw new GoScopeError("missing_token", "缺少 GO 访问令牌", 401);

  const { data: userData, error: userErr } = await goClient(env).auth.getUser(token);
  if (userErr || !userData?.user) {
    throw new GoScopeError("invalid_go_token", "GO 访问令牌无效或已过期", 401);
  }
  const goUserId = userData.user.id;

  const { data: raw, error: rpcErr } = await goClient(env, token).rpc(GO_SCOPE_RPC);
  if (rpcErr) throw new GoScopeError("go_scope_unavailable", "GO 身份服务暂时不可用", 503);

  const first = Array.isArray(raw) ? raw[0] : raw;
  const root =
    first && typeof first === "object" && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : null;
  if (!root) throw new GoScopeError("go_scope_unavailable", "GO 身份上下文不可用", 503);
  if (root["authenticated"] !== true) {
    throw new GoScopeError("invalid_go_token", "GO 访问令牌无效或已过期", 401);
  }
  const claimedGoUser = typeof root["user_id"] === "string" ? root["user_id"].trim() : "";
  if (!claimedGoUser || claimedGoUser !== goUserId) {
    throw new GoScopeError("go_identity_mismatch", "GO 身份与访问令牌不一致", 403);
  }
  const erpUserId = typeof root["erp_user_id"] === "string" ? root["erp_user_id"].trim() : "";
  if (root["is_erp_user"] !== true || !UUID_RE.test(erpUserId)) {
    throw new GoScopeError("go_identity_not_linked", "该 GO 账号尚未绑定 ERP 账号", 403);
  }

  return { goUserId, erpUserId, token, env };
}

/**
 * 数据库内一致性快照 → 授权契约。
 * 版本来自持久快照表（payload hash + 单调整数），并发旧读取不会拿到更高版本。
 */
export async function loadAuthorizationSnapshot(
  erpUserId: string,
  goUserId: string,
): Promise<AuthorizationSnapshot> {
  const { data, error } = await supabaseAdmin.rpc(
    "go_authorization_snapshot" as never,
    {
      p_erp_user_id: erpUserId,
      p_go_user_id: goUserId,
      p_permission_rev: PERMISSION_MODEL_REV,
    } as never,
  );
  if (error) throw new GoScopeError("authorization_unavailable", "授权快照暂不可用", 503);
  const facts = data as unknown as AuthorizationFacts | null;
  if (!facts || typeof facts !== "object") {
    throw new GoScopeError("authorization_unavailable", "授权快照暂不可用", 503);
  }
  return buildAuthorizationSnapshot({
    ...facts,
    roles: Array.isArray(facts.roles) ? facts.roles : [],
    location_ids: Array.isArray(facts.location_ids) ? facts.location_ids : [],
    shop_links: Array.isArray(facts.shop_links) ? facts.shop_links : [],
    version: Number(facts.version) || 0,
  });
}

/** 读取 GO 侧可信镜像回执并确认该用户的 outbox（不信客户端 id / ok） */
export async function confirmAuthorizationReceipt(
  identity: GoIdentity,
  now = new Date(),
): Promise<{ snapshot: AuthorizationSnapshot; confirmed: number; receipt_status: string }> {
  const snapshot = await loadAuthorizationSnapshot(identity.erpUserId, identity.goUserId);

  const { data: raw, error } = await goClient(identity.env, identity.token).rpc(GO_RECEIPT_RPC);
  if (error) throw new GoScopeError("go_receipt_unavailable", "GO 回执服务暂时不可用", 503);

  const receipt = parseGoReceiptPayload(raw, {
    expectedGoUserId: identity.goUserId,
    expectedErpUserId: identity.erpUserId,
    currentVersion: snapshot.scope_version,
    expectedLinkStatus: expectedLinkStatus(snapshot),
    now,
  });

  const { data: ack, error: ackErr } = await supabaseAdmin.rpc(
    "go_authorization_ack" as never,
    { p_erp_user_id: identity.erpUserId, p_version: receipt.scopeVersion } as never,
  );
  if (ackErr) throw new GoScopeError("authorization_ack_failed", "授权回执写入失败", 503);

  const result = (ack ?? {}) as { ok?: boolean; code?: string; confirmed?: number };
  if (result.ok !== true) {
    // 事务内复核失败（版本已被新授权顶掉）→ 不确认任何事件，让 GO 重新拉取
    throw new GoScopeError(
      result.code === "version_stale" ? "receipt_version_stale" : "authorization_ack_failed",
      "ERP 授权已更新，请重新拉取后再回执",
      409,
    );
  }

  return {
    snapshot,
    confirmed: Number(result.confirmed) || 0,
    receipt_status: receipt.linkStatus,
  };
}


export const GO_AUTHZ_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export function authzJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...GO_AUTHZ_CORS },
  });
}

export function authzError(e: unknown) {
  if (e instanceof GoScopeError || e instanceof GoReceiptError) {
    return authzJson({ ok: false, code: e.code, error: e.message }, e.status);
  }
  return authzJson({ ok: false, code: "internal_error", error: "服务暂时不可用" }, 500);
}
