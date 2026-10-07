// 手持端自定义卡片路由公共包装：device + 员工 session 双认证，错误不泄漏内部细节。
import { authenticateDevice, err, json, ok, resolveSessionUser } from "@/server/handheld-auth.server";
import type { Actor } from "@/server/custom-print-cards.server";

export async function withActor(request: Request, run: (a: Actor) => Promise<{ status: number; body?: unknown; code?: string }>) {
  try {
    const auth = await authenticateDevice(request);
    if (!auth.ok) return auth.response;
    const session = await resolveSessionUser(request);
    if (!session) return err("Employee session required", 401, { code: "session_required" });
    const r = await run({ userId: session.user_id, deviceId: auth.device.id });
    if (r.code) return err(r.code, r.status, { code: r.code });
    return r.status === 202 ? json({ ok: true, data: r.body }, { status: 202 }) : ok(r.body);
  } catch {
    return err("Custom cards unavailable", 500, { code: "internal_error" });
  }
}

export async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 16_384) return null;
  try { return JSON.parse(text); } catch { return null; }
}
