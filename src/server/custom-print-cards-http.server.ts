// 手持端自定义卡片路由公共包装：device + 员工 session 双认证，错误不泄漏内部细节。
import { authenticateDevice, err, json, ok, resolveSessionUser } from "@/server/handheld-auth.server";
import type { Actor } from "@/server/custom-print-cards.server";

/** 机器 code → 原生可直接展示的中文提示；code 原样保留在响应里。 */
export const CUSTOM_CARD_MESSAGES: Record<string, string> = {
  session_required: "登录已失效，请重新登录员工账号",
  location_forbidden: "你没有当前库位的权限，请切换到已授权的库位",
  admin_only: "只有超级管理员可以发布或修改全门店预设",
  reference_forbidden: "参考照片不属于本设备上传，请在本机重新上传",
  reference_invalid: "参考照片不存在或不是有效图片，请重新上传",
  not_found: "卡片不存在或不属于当前库位，请刷新列表",
  version_conflict: "卡片已被修改，请退出编辑并重新加载后再操作",
  client_op_conflict: "重复提交的内容不一致，请重新加载后再创建",
  not_ready: "卡片文案尚未生成完成，请等待生成成功后再发布",
  validation_error: "请检查内容：主题1–120字，标题≤18字、短句≤20字、正文≤90字且都不能为空",
  ai_consent_required: "AI 处理未授权：请在 App「设置 › AI 授权」中同意后再生成；手动填写内容仍可打印",
  internal_error: "服务暂时不可用，请稍后重试",
};
export const customCardMessage = (code: string) => CUSTOM_CARD_MESSAGES[code] ?? CUSTOM_CARD_MESSAGES.internal_error;

export async function withActor(request: Request, run: (a: Actor) => Promise<{ status: number; body?: unknown; code?: string }>) {
  try {
    const auth = await authenticateDevice(request);
    if (!auth.ok) return auth.response;
    const session = await resolveSessionUser(request);
    if (!session) return err(customCardMessage("session_required"), 401, { code: "session_required" });
    const r = await run({ userId: session.user_id, deviceId: auth.device.id });
    if (r.code) return err(customCardMessage(r.code), r.status, { code: r.code });
    return r.status === 202 ? json({ ok: true, data: r.body }, { status: 202 }) : ok(r.body);
  } catch {
    return err(customCardMessage("internal_error"), 500, { code: "internal_error" });
  }
}

export async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 16_384) return null;
  try { return JSON.parse(text); } catch { return null; }
}
