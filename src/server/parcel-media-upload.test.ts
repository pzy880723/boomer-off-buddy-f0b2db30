import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_FOLDERS,
  MAX_FILE_BYTES,
  MAX_MULTIPART_BYTES,
  PARCEL_MEDIA_BUCKET,
  REQUIRED_TENCENT_MEDIA_URL,
  buildObjectPath,
  detectImageType,
  handleParcelMediaUpload,
  type ParcelMediaUploadDeps,
} from "./parcel-media-upload.server";

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PARCEL = "11111111-2222-4333-8444-555555555555";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const GIF = new Uint8Array([...Buffer.from("GIF89a"), 1, 2, 3, 4, 5, 6, 7, 8]);
const WEBP = new Uint8Array([
  ...Buffer.from("RIFF"), 20, 0, 0, 0, ...Buffer.from("WEBP"), ...Buffer.from("VP8 "),
]);
const SVG = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));

type Call = { path: string; contentType: string; size: number };

function makeDeps(overrides: Partial<ParcelMediaUploadDeps> = {}) {
  const calls: Call[] = [];
  const authCalls: string[] = [];
  const deps: ParcelMediaUploadDeps = {
    getUploader: () => ({
      async upload(path, bytes, contentType) {
        calls.push({ path, contentType, size: bytes.byteLength });
        return { error: null };
      },
      publicUrl: (path) => `${REQUIRED_TENCENT_MEDIA_URL}/storage/v1/object/public/${PARCEL_MEDIA_BUCKET}/${path}`,
    }),
    async authenticate(token) {
      authCalls.push(token);
      if (token === "good") return { id: "user-1", isAnonymous: false };
      if (token === "anon") return { id: "user-2", isAnonymous: true };
      if (token === "boom") throw new Error("network");
      return null;
    },
    uuid: () => UUID,
    ...overrides,
  };
  return { deps, calls, authCalls };
}

function req(
  body: FormData | null,
  { token, contentLength }: { token?: string; contentLength?: number } = {},
): Request {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const request = new Request("https://erp.example/api/internal/media/parcel-upload", {
    method: "POST",
    headers,
    body: body ?? undefined,
  });
  if (contentLength !== undefined) {
    Object.defineProperty(request, "headers", {
      value: new Headers({ ...Object.fromEntries(headers), "content-length": String(contentLength) }),
    });
  }
  return request;
}

function form(bytes: Uint8Array, folder = "items", extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("folder", folder);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  fd.set("file", new Blob([bytes as unknown as BlobPart], { type: "image/png" }), "x.png");
  return fd;
}

/** 无 Content-Length 的 chunked 流式请求，可观察 cancel 与已拉取块数 */
function streamingReq(
  chunks: Uint8Array[],
  opts: { token?: string; contentType?: string } = {},
) {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls < chunks.length) {
        controller.enqueue(chunks[pulls] as unknown as Uint8Array<ArrayBuffer>);
        pulls += 1;
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = new Headers();
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.contentType) headers.set("content-type", opts.contentType);
  const request = new Request("https://erp.example/api/internal/media/parcel-upload", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, stats: () => ({ pulls, cancelled }) };
}

// ---------- 魔数识别 ----------
test("detectImageType 只接受 jpeg/png/webp/gif，拒绝 SVG 与伪造 MIME", () => {
  assert.deepEqual(detectImageType(PNG), { mime: "image/png", ext: "png" });
  assert.deepEqual(detectImageType(JPEG), { mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(detectImageType(GIF), { mime: "image/gif", ext: "gif" });
  assert.deepEqual(detectImageType(WEBP), { mime: "image/webp", ext: "webp" });
  assert.equal(detectImageType(SVG), null);
  assert.equal(detectImageType(new Uint8Array([1, 2, 3])), null);
});

test("buildObjectPath 服务端生成 UUID 路径，skus 不带 parcelId", () => {
  assert.equal(buildObjectPath("items", "png", UUID, PARCEL), `items/${PARCEL}/${UUID}.png`);
  assert.equal(buildObjectPath("items", "png", UUID, null), `items/${UUID}.png`);
  assert.equal(buildObjectPath("skus", "webp", UUID, PARCEL), `skus/${UUID}.webp`);
  assert.deepEqual([...ALLOWED_FOLDERS], ["items", "receive", "sort", "search", "skus"]);
});

// ---------- 开关 ----------
test("未配置腾讯媒体端点时返回 503 且不读取请求体", async () => {
  const { deps, authCalls } = makeDeps({ getUploader: () => null });
  const res = await handleParcelMediaUpload(req(form(PNG), { token: "good" }), deps);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "media_upload_disabled" });
  assert.deepEqual(authCalls, []);
});

// ---------- 认证 ----------
test("缺 token / 非法 token / 匿名用户一律 401，且不落盘", async () => {
  for (const token of [undefined, "bad", "anon", "boom"]) {
    const { deps, calls } = makeDeps();
    const res = await handleParcelMediaUpload(req(form(PNG), { token }), deps);
    assert.equal(res.status, 401, `token=${token}`);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
    assert.deepEqual(calls, []);
  }
});

// ---------- 大小 ----------
test("multipart 总量超限直接 413", async () => {
  const { deps, calls } = makeDeps();
  const res = await handleParcelMediaUpload(
    req(form(PNG), { token: "good", contentLength: 20 * 1024 * 1024 }),
    deps,
  );
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "payload_too_large" });
  assert.deepEqual(calls, []);
});

test("单文件超过 8MiB 返回 413", async () => {
  const big = new Uint8Array(MAX_FILE_BYTES + 1);
  big.set(PNG.subarray(0, 8));
  const { deps, calls } = makeDeps();
  const res = await handleParcelMediaUpload(req(form(big), { token: "good" }), deps);
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "file_too_large" });
  assert.deepEqual(calls, []);
});

// ---------- 类型 / 路径 ----------
test("伪造成 image/png 的 SVG 被拒绝 415", async () => {
  const { deps, calls } = makeDeps();
  const res = await handleParcelMediaUpload(req(form(SVG), { token: "good" }), deps);
  assert.equal(res.status, 415);
  assert.deepEqual(await res.json(), { error: "unsupported_image_type" });
  assert.deepEqual(calls, []);
});

test("非法 folder / 非法 parcel_id / 缺文件 返回 400", async () => {
  const cases: Array<[FormData, string]> = [
    [form(PNG, "../secret"), "invalid_folder"],
    [form(PNG, "avatars"), "invalid_folder"],
    [form(PNG, "items", { parcel_id: "not-a-uuid" }), "invalid_parcel_id"],
    [(() => { const fd = new FormData(); fd.set("folder", "items"); return fd; })(), "missing_file"],
  ];
  for (const [fd, error] of cases) {
    const { deps, calls } = makeDeps();
    const res = await handleParcelMediaUpload(req(fd, { token: "good" }), deps);
    assert.equal(res.status, 400, error);
    assert.deepEqual(await res.json(), { error });
    assert.deepEqual(calls, []);
  }
});

// ---------- 成功 ----------
test("成功上传返回第二 client 的稳定公开 URL，且只写 parcel-item-images", async () => {
  const { deps, calls } = makeDeps();
  const res = await handleParcelMediaUpload(
    req(form(JPEG, "receive", { parcel_id: PARCEL }), { token: "good" }),
    deps,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { url: string; path: string };
  assert.equal(body.path, `receive/${PARCEL}/${UUID}.jpg`);
  assert.equal(
    body.url,
    `${REQUIRED_TENCENT_MEDIA_URL}/storage/v1/object/public/${PARCEL_MEDIA_BUCKET}/receive/${PARCEL}/${UUID}.jpg`,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.contentType, "image/jpeg");
  assert.equal(calls[0]?.path, body.path);
});

// ---------- 后端失败不回退 ----------
test("腾讯后端失败返回 502，不回退 Lovable、不返回 URL", async () => {
  const { deps } = makeDeps({
    getUploader: () => ({
      async upload() {
        return { error: new Error("bucket unavailable") };
      },
      publicUrl: () => "https://should-not-be-used",
    }),
  });
  const res = await handleParcelMediaUpload(req(form(PNG), { token: "good" }), deps);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "upload_failed" });
});
