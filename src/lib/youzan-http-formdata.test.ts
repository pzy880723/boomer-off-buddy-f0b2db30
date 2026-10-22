import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
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

test("FormData 编码为真实 multipart 字节，envelope 带 bodyBase64 与 boundary content-type", async () => {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: "image/jpeg" }), "a.jpg");
  fd.append("source", "erp");

  const res = await youzanFetch(TARGET, { method: "POST", body: fd });
  assert.equal(res.status, 200);
  assert.ok(captured);
  assert.equal(captured!.url, TARGET);
  assert.equal(captured!.method, "POST");
  assert.equal(captured!.body, null);
  assert.equal(typeof captured!.bodyBase64, "string");

  const contentType = captured!.headers["content-type"];
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  const boundary = contentType.split("boundary=")[1];

  const decoded = Buffer.from(captured!.bodyBase64!, "base64");
  const raw = decoded.toString("latin1");
  assert.ok(raw.includes(`--${boundary}`), "body contains boundary");
  assert.ok(raw.includes('name="file"; filename="a.jpg"'), "file part header");
  assert.ok(raw.includes('name="source"'), "field part header");
  assert.ok(raw.includes("erp"), "field value");
  // 二进制字节原样保留（JPEG SOI 头）
  const soi = decoded.indexOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  assert.ok(soi > -1, "JPEG SOI present");
  assert.deepEqual([...decoded.subarray(soi, soi + 7)], [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
});

test("普通 JSON/text 请求路径不变：仍走 body 文本，不带 bodyBase64", async () => {
  await youzanFetch(TARGET, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"kdt_id":1}',
  });
  assert.equal(captured!.body, '{"kdt_id":1}');
  assert.equal("bodyBase64" in captured!, false);
  assert.equal(captured!.headers["content-type"], "application/json");
});

test("超过 3MiB+64KiB 的 multipart 被拒绝", async () => {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(3 * 1024 * 1024 + 128 * 1024)]), "big.bin");
  await assert.rejects(youzanFetch(TARGET, { method: "POST", body: fd }), /3MiB/);
  assert.equal(captured, null);
});
