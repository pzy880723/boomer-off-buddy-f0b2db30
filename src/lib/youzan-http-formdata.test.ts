import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { youzanFetch } from "./youzan-http";

const PROXY_URL = "https://proxy.example.com/relay";
const TARGET = "https://open.youzanyun.com/api/youzan.retail.material.upload/1.0.0";

type CapturedEnvelope = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  bodyBase64?: string;
};

let captured: CapturedEnvelope | null = null;
let originalFetch: typeof globalThis.fetch;

function decodeBase64(b64: string): string {
  return Buffer.from(b64, "base64").toString("latin1");
}

beforeEach(() => {
  captured = null;
  originalFetch = globalThis.fetch;
  process.env.YOUZAN_PROXY_URL = PROXY_URL;
  delete process.env.YOUZAN_PROXY_TOKEN;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as CapturedEnvelope;
    return new Response(JSON.stringify({ status: 200, body: '{"code":200}' }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.YOUZAN_PROXY_URL;
});

describe("youzanFetch FormData → bodyBase64", () => {
  test("FormData 编码为真实 multipart 字节，envelope 带 bodyBase64 与 boundary content-type", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: "image/jpeg" }), "a.jpg");
    fd.append("source", "erp");

    const res = await youzanFetch(TARGET, { method: "POST", body: fd });
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(TARGET);
    expect(captured!.method).toBe("POST");
    expect(captured!.body).toBeNull();
    expect(typeof captured!.bodyBase64).toBe("string");

    const contentType = captured!.headers["content-type"];
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    const boundary = contentType.split("boundary=")[1];

    const raw = decodeBase64(captured!.bodyBase64!);
    // 字节完整性：base64 解码长度与内容均可还原
    expect(raw).toContain(`--${boundary}`);
    expect(raw).toContain('name="file"; filename="a.jpg"');
    expect(raw).toContain('name="source"');
    expect(raw).toContain("erp");
    // 二进制字节原样保留（JPEG SOI 头）
    expect(raw.charCodeAt(raw.indexOf("\r\n\r\n") + 4) & 0xff).toBe(0xff);
    const decoded = Buffer.from(captured!.bodyBase64!, "base64");
    const soi = decoded.indexOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    expect(soi).toBeGreaterThan(-1);
    expect(decoded.subarray(soi, soi + 7)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  });

  test("普通 JSON/text 请求路径不变：仍走 body 文本，不带 bodyBase64", async () => {
    await youzanFetch(TARGET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"kdt_id":1}',
    });
    expect(captured!.body).toBe('{"kdt_id":1}');
    expect("bodyBase64" in captured!).toBe(false);
    expect(captured!.headers["content-type"]).toBe("application/json");
  });

  test("超过 3MiB+64KiB 的 multipart 被拒绝", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(3 * 1024 * 1024 + 128 * 1024)]), "big.bin");
    await expect(youzanFetch(TARGET, { method: "POST", body: fd })).rejects.toThrow("3MiB");
    expect(captured).toBeNull();
  });
});
