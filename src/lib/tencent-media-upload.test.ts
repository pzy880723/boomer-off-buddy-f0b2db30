import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PARCEL_UPLOAD_ENDPOINT,
  shouldUseTencentMediaUploads,
  uploadParcelBlobViaTencent,
} from "./tencent-media-upload";

const blob = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

test("开关默认 off；只有字符串 'true' 才启用", () => {
  assert.equal(shouldUseTencentMediaUploads(undefined), false);
  assert.equal(shouldUseTencentMediaUploads({}), false);
  assert.equal(shouldUseTencentMediaUploads({ VITE_TENCENT_MEDIA_UPLOADS: "false" }), false);
  assert.equal(shouldUseTencentMediaUploads({ VITE_TENCENT_MEDIA_UPLOADS: true }), false);
  assert.equal(shouldUseTencentMediaUploads({ VITE_TENCENT_MEDIA_UPLOADS: "true" }), true);
});

test("未登录（无 access_token）直接报错，不发请求", async () => {
  let called = 0;
  await assert.rejects(
    uploadParcelBlobViaTencent(blob(), "items", null, {
      getAccessToken: async () => null,
      fetchImpl: (async () => {
        called += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    }),
    /请先登录/,
  );
  assert.equal(called, 0);
});

test("成功时携带 Bearer token 与白名单 folder，返回稳定 URL", async () => {
  let seen: { url: string; token: string | null; folder: unknown; parcel: unknown } | null = null;
  const url = await uploadParcelBlobViaTencent(blob(), "receive", "11111111-2222-4333-8444-555555555555", {
    getAccessToken: async () => "tok-123",
    fetchImpl: (async (input: string, init: RequestInit) => {
      const fd = init.body as FormData;
      seen = {
        url: String(input),
        token: new Headers(init.headers).get("authorization"),
        folder: fd.get("folder"),
        parcel: fd.get("parcel_id"),
      };
      return new Response(JSON.stringify({ url: "https://migration-data.boomeroff.top/x.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  assert.equal(url, "https://migration-data.boomeroff.top/x.png");
  assert.deepEqual(seen, {
    url: PARCEL_UPLOAD_ENDPOINT,
    token: "Bearer tok-123",
    folder: "receive",
    parcel: "11111111-2222-4333-8444-555555555555",
  });
});

test("后端失败时抛错，绝不回退 Lovable 上传", async () => {
  await assert.rejects(
    uploadParcelBlobViaTencent(blob(), "items", null, {
      getAccessToken: async () => "tok",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "upload_failed" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    }),
    /502 upload_failed/,
  );
});

test("返回体缺 url 也算失败", async () => {
  await assert.rejects(
    uploadParcelBlobViaTencent(blob(), "items", null, {
      getAccessToken: async () => "tok",
      fetchImpl: (async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    }),
    /无返回地址/,
  );
});
