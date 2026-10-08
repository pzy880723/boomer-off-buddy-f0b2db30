import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { mapFankuangDbError } from "@/lib/commerce/fankuang-gift";
import { storefrontError, storefrontPrivateJson } from "@/server/storefront-auth.server";

/** 调用翻筐乐 RPC（仅 service_role 可执行）；数据库错误映射为稳定错误码。 */
export async function callFankuangRpc(name: string, args: Record<string, unknown>): Promise<Response | { data: unknown }> {
  const { data, error } = await supabaseAdmin.rpc(name as never, args as never);
  if (error) {
    const mapped = mapFankuangDbError(error.message);
    if (mapped) return storefrontError(error.message, mapped.status, mapped.code);
    return storefrontError("翻筐乐暂不可用，请稍后重试", 503, "fankuang_unavailable");
  }
  return { data };
}

export function fankuangOk(data: unknown, status = 200) {
  return storefrontPrivateJson({ ok: true, data }, { status });
}
