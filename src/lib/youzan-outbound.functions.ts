import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getYouzanOutboundStatus } from "./youzan-http";

const SETTINGS_KEY = "youzan_proxy_outbound_ip";

function getProxyUrl() {
  const raw = process.env.YOUZAN_PROXY_URL?.trim();
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
}

/**
 * 通过代理的 whoami 探针获取固定出口 IP。
 * 代理端 (server.mjs) 收到 { probe: "whoami" } 会请求 ipify 拿到自身公网 IP 并返回。
 */
export const detectYouzanOutboundIp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const status = getYouzanOutboundStatus();
    if (status.mode !== "fixed_proxy") {
      throw new Error("未配置固定出口代理（YOUZAN_PROXY_URL），无法自动探测");
    }

    const proxyUrl = getProxyUrl();
    if (!proxyUrl) throw new Error("YOUZAN_PROXY_URL 未配置");

    const token = process.env.YOUZAN_PROXY_TOKEN?.trim();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    let raw = "";
    let ip: string | null = null;
    let source = "ipify";

    try {
      const res = await fetch(proxyUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ probe: "whoami" }),
      });
      raw = await res.text();
      if (!res.ok) {
        throw new Error(`代理返回 HTTP ${res.status}：${raw.slice(0, 240)}`);
      }
      const json = JSON.parse(raw) as { ok?: boolean; ip?: string; source?: string; error?: string };
      if (json.error) throw new Error(`代理返回错误：${json.error}`);
      if (!json.ip) throw new Error(`代理未返回 IP：${raw.slice(0, 240)}`);
      ip = json.ip;
      source = json.source ?? "ipify";
    } catch (e) {
      throw new Error(
        e instanceof Error
          ? `whoami 探针失败：${e.message}`
          : `whoami 探针失败：${String(e)}`,
      );
    }

    const { supabase } = context;
    const { error: upErr } = await supabase.from("app_settings").upsert({
      key: SETTINGS_KEY,
      value: { ip, detected_at: new Date().toISOString(), source },
      updated_at: new Date().toISOString(),
    });
    if (upErr) throw new Error(upErr.message);

    return {
      ip,
      source,
      saved: true,
      message: `已检测到出口 IP ${ip}，请把该 IP 加入有赞后台 → 应用管理 → IP 白名单。`,
    };
  });
