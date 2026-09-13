/**
 * 首批图片存储切换：公开桶 parcel-item-images 的客户端上传改走腾讯 COS-backed
 * Supabase Storage（第二个 server-only client）。
 *
 * 本文件只含纯逻辑 + 可注入依赖的 handler，便于单元测试。
 * 不触碰主 supabaseAdmin 的业务库/auth 用途（认证仍由主库 auth.getUser 完成）。
 */

export const PARCEL_MEDIA_BUCKET = "parcel-item-images";

/** 允许的目录前缀（服务端白名单，客户端无法任意指定 bucket/path） */
export const ALLOWED_FOLDERS = ["items", "receive", "sort", "search", "skus"] as const;
export type ParcelMediaFolder = (typeof ALLOWED_FOLDERS)[number];

/** 单文件上限 8 MiB */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** multipart 整体上限（含边界/字段开销） */
export const MAX_MULTIPART_BYTES = 9 * 1024 * 1024;

/** 必须固定的腾讯媒体端点，不允许任意目标 / localhost */
export const REQUIRED_TENCENT_MEDIA_URL = "https://migration-data.boomeroff.top";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAllowedFolder(value: unknown): value is ParcelMediaFolder {
  return typeof value === "string" && (ALLOWED_FOLDERS as readonly string[]).includes(value);
}

export type DetectedImage = { mime: string; ext: string };

/** 仅按魔数识别 jpeg/png/webp/gif；SVG 与伪造 MIME 一律拒绝。 */
export function detectImageType(bytes: Uint8Array): DetectedImage | null {
  if (bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  const ascii = (start: number, len: number) =>
    String.fromCharCode(...b.subarray(start, start + len));
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return { mime: "image/gif", ext: "gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

/** 服务端生成对象路径，客户端只能影响 folder 与可选 parcelId */
export function buildObjectPath(
  folder: ParcelMediaFolder,
  ext: string,
  uuid: string,
  parcelId?: string | null,
): string {
  const sub = parcelId && folder !== "skus" ? `${folder}/${parcelId}` : folder;
  return `${sub}/${uuid}.${ext}`;
}

export type TencentMediaUploader = {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<{ error: unknown | null }>;
  publicUrl(path: string): string;
};

export type ParcelMediaUploadDeps = {
  /** 未配置腾讯媒体端点时返回 null（开关关闭 / 缺 env） */
  getUploader(): TencentMediaUploader | null;
  /** 用主 Lovable supabaseAdmin 校验 Bearer token 对应的真实登录用户 */
  authenticate(token: string): Promise<{ id: string; isAnonymous: boolean } | null>;
  uuid(): string;
};

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export async function handleParcelMediaUpload(
  request: Request,
  deps: ParcelMediaUploadDeps,
): Promise<Response> {
  const uploader = deps.getUploader();
  if (!uploader) return json({ error: "media_upload_disabled" }, 503);

  // 1) 先认证，再读取请求体
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  let user: { id: string; isAnonymous: boolean } | null = null;
  try {
    user = await deps.authenticate(token);
  } catch {
    return json({ error: "unauthorized" }, 401);
  }
  if (!user || user.isAnonymous) return json({ error: "unauthorized" }, 401);

  // 2) 总量上限（先看声明长度，读完后再按实际字节复核）
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_MULTIPART_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "invalid_form" }, 400);
  }

  const folder = form.get("folder");
  if (!isAllowedFolder(folder)) return json({ error: "invalid_folder" }, 400);

  const parcelIdRaw = form.get("parcel_id");
  let parcelId: string | null = null;
  if (typeof parcelIdRaw === "string" && parcelIdRaw.length > 0) {
    if (!UUID_RE.test(parcelIdRaw)) return json({ error: "invalid_parcel_id" }, 400);
    parcelId = parcelIdRaw;
  }

  const file = form.get("file");
  if (!file || typeof file === "string" || typeof (file as Blob).arrayBuffer !== "function") {
    return json({ error: "missing_file" }, 400);
  }
  const blob = file as Blob;
  if (blob.size > MAX_FILE_BYTES) return json({ error: "file_too_large" }, 413);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: "file_too_large" }, 413);

  const detected = detectImageType(bytes);
  if (!detected) return json({ error: "unsupported_image_type" }, 415);

  const path = buildObjectPath(folder, detected.ext, deps.uuid(), parcelId);
  const { error } = await uploader.upload(path, bytes, detected.mime);
  // 开关打开时后端失败不得偷偷回退 Lovable
  if (error) return json({ error: "upload_failed" }, 502);

  return json({ url: uploader.publicUrl(path), path }, 200);
}
