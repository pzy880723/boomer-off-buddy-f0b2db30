import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { youzanFetch, getYouzanOutboundStatus } from "./youzan-http";

const SETTINGS_KEY = "youzan_proxy_outbound_ip";
const IPV4 = /(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/;

function extractIp(text: string): string | null {
  const m = IPV4.exec(text);
  if (!m) return null;
  const parts = m[1].split(".").map(Number);
  if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  return m[1];
}

/**
 * 探测有赞代理的固定出口 IP：故意用无效 client_id 请求 oauth/token，
 * 有赞在 IP 未加白时会返回 "IP x.x.x.x is not in whitelist"，从中解析。
 * 若已加白但凭据错误，则回包不含 IP，会尝试 ip-api 备选。
 */
export const detectYouzanOutboundIp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const status = getYouzanOutboundStatus();
    if (status.mode !== "fixed_proxy") {
      throw new Error("未配置固定出口代理（YOUZAN_PROXY_URL），无法自动探测");
    }

    let ip: string | null = null;
    let source: "youzan_whitelist_msg" | "ipify_via_proxy" = "youzan_whitelist_msg";
    let raw = "";

    // 1) 主路径：oauth/token 的 4007 错误里就带 IP
    try {
      const res = await youzanFetch("https://open.youzanyun.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=silent&client_id=__probe__&client_secret=__probe__",
      });
      raw = await res.text();
      ip = extractIp(raw);
    } catch (e) {
      raw = e instanceof Error ? e.message : String(e);
      ip = extractIp(raw);
    }

    // 2) 备选：如果凭据侥幸通过或错误里无 IP，再问一次 ipify（同样走代理即可）
    //    但 youzanFetch 只允许 open.youzanyun.com，退回读取代理 /healthz 的 x-forwarded-for？
    //    简单起见：如果解析不到，直接报错让用户手动检查。
    if (!ip) {
      throw new Error(
        `未能从有赞返回中解析到出口 IP。可能情况：\n` +
          `1. 你的 IP 已经在白名单里 → 报错里就没有 IP 了；\n` +
          `2. 代理返回异常。\n\n原始返回片段：${raw.slice(0, 400)}`,
      );
    }

    const { supabase } = context;
    const { error: upErr } = await supabase.from("app_settings").upsert({
      key: SETTINGS_KEY,
      value: { ip, detected_at: new Date().toISOString(), source },
      updated_at: new Date().toISOString(),
    });
    if (upErr) throw new Error(upErr.message);

    return { ip, source, saved: true };
  });

