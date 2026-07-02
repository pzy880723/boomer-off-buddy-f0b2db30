type ProxyEnvelope = {
  status?: number;
  statusText?: string;
  headers?: Record<string, string> | Array<[string, string]>;
  body?: string;
  bodyBase64?: string;
  error?: string;
};

export type YouzanOutboundStatus = {
  mode: "fixed_proxy" | "direct_dynamic";
  configured: boolean;
  proxy_host: string | null;
  outbound_ip: string | null;
  message: string;
};

const YOUZAN_ALLOWED_HOSTS = new Set(["open.youzanyun.com"]);

function getProxyUrl() {
  const raw = process.env.YOUZAN_PROXY_URL?.trim();
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
}

function assertYouzanUrl(targetUrl: string) {
  const u = new URL(targetUrl);
  if (u.protocol !== "https:") {
    throw new Error("有赞接口必须使用 HTTPS");
  }
  if (!YOUZAN_ALLOWED_HOSTS.has(u.hostname)) {
    throw new Error(`固定出口代理拒绝非有赞域名：${u.hostname}`);
  }
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  const h = new Headers(headers);
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function bodyToText(body: BodyInit | null | undefined): Promise<string | null> {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) {
    throw new Error("有赞固定出口代理暂不支持 FormData 请求体");
  }
  if (body instanceof Blob) return await body.text();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  throw new Error("有赞固定出口代理暂不支持流式请求体");
}

function decodeProxyBody(envelope: ProxyEnvelope) {
  if (typeof envelope.body === "string") return envelope.body;
  if (typeof envelope.bodyBase64 === "string") {
    return Uint8Array.from(atob(envelope.bodyBase64), (c) => c.charCodeAt(0));
  }
  return "";
}

export function getYouzanOutboundStatus(): YouzanOutboundStatus {
  const proxyUrl = getProxyUrl();
  const outboundIp = process.env.YOUZAN_PROXY_OUTBOUND_IP?.trim() || null;
  if (!proxyUrl) {
    return {
      mode: "direct_dynamic",
      configured: false,
      proxy_host: null,
      outbound_ip: null,
      message: "当前直连有赞，后端出口 IP 可能随云端调度变化；发布后也不保证固定。",
    };
  }
  return {
    mode: "fixed_proxy",
    configured: true,
    proxy_host: new URL(proxyUrl).host,
    outbound_ip: outboundIp,
    message: outboundIp
      ? `固定出口代理已启用；有赞白名单只需要配置 ${outboundIp}。`
      : "固定出口代理已启用；建议补充 YOUZAN_PROXY_OUTBOUND_IP 用于页面展示。",
  };
}

export async function youzanFetch(targetUrl: string, init: RequestInit = {}): Promise<Response> {
  assertYouzanUrl(targetUrl);
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return fetch(targetUrl, init);

  const token = process.env.YOUZAN_PROXY_TOKEN?.trim();
  const body = await bodyToText(init.body ?? null);
  const proxyHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) proxyHeaders.Authorization = `Bearer ${token}`;

  const proxyRes = await fetch(proxyUrl, {
    method: "POST",
    headers: proxyHeaders,
    body: JSON.stringify({
      url: targetUrl,
      method: init.method ?? "GET",
      headers: headersToRecord(init.headers),
      body,
    }),
    signal: init.signal,
  });

  const text = await proxyRes.text();
  if (!proxyRes.ok) {
    throw new Error(`固定出口代理不可用：HTTP ${proxyRes.status} ${text.slice(0, 240)}`);
  }

  let envelope: ProxyEnvelope | null = null;
  try {
    envelope = JSON.parse(text) as ProxyEnvelope;
  } catch {
    return new Response(text, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: proxyRes.headers,
    });
  }

  if (envelope.error) {
    throw new Error(`固定出口代理调用失败：${envelope.error}`);
  }
  if (typeof envelope.status === "number") {
    return new Response(decodeProxyBody(envelope), {
      status: envelope.status,
      statusText: envelope.statusText,
      headers: envelope.headers,
    });
  }

  return new Response(text, {
    status: proxyRes.status,
    statusText: proxyRes.statusText,
    headers: proxyRes.headers,
  });
}