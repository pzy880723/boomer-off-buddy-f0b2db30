/**
 * iOS 兼容入口 POST /api/public/handheld/print/store-qr 的核心逻辑（依赖注入便于测试）。
 * - get：门店读权限；仅返回 active 且有原图的渠道（短签名 URL），停用/缺码不返回、不替用。
 * - save：先鉴权（仅 super_admin），再验 PNG/JPEG 真实魔数与 ≤15MB，原始字节不重绘；
 *   对象路径由服务端生成 {location}/{channel}/{uuid}.{ext}，不接受外部 image_path。
 *   DB 失败时只清理本次新对象；旧对象从不删除（其他版本可能仍引用）。
 */
import { z } from "zod";
import type { QrRow } from "./store-qr.server";

export const QR_BUCKET = "store-qr";
export const QR_MAX_BYTES = 15 * 1024 * 1024;
export const QR_SIGN_TTL = 300;

export const CHANNEL_TO_PURPOSE = {
  wechat: "wecom_contact", // 门店个人/企微联系码，非公众号
  xiaohongshu: "xiaohongshu",
  dianping: "dianping",
  identify: "identify",
  miniprogram: "mini_program",
} as const;
export type QrChannel = keyof typeof CHANNEL_TO_PURPOSE;
const CHANNELS = Object.keys(CHANNEL_TO_PURPOSE) as QrChannel[];
const PURPOSE_TO_CHANNEL = new Map(Object.entries(CHANNEL_TO_PURPOSE).map(([c, p]) => [p as string, c as QrChannel]));

export type QrPrintDeps = {
  canAccessLocation(userId: string, locationId: string): Promise<boolean>;
  roles(userId: string): Promise<string[]>;
  list(locationId: string): Promise<QrRow[]>;
  sign(bucket: string, path: string, ttl: number): Promise<string | null>;
  upload(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  remove(path: string): Promise<void>;
  saveImage(row: { location_id: string; purpose: string; image_path: string; updated_by: string }): Promise<{ updated_at: string } | null>;
  newObjectId(): string;
};

const Get = z.object({ action: z.literal("get"), location_id: z.string().uuid() }).strict();
const Save = z
  .object({
    action: z.literal("save"),
    location_id: z.string().uuid(),
    channel: z.enum(CHANNELS as [QrChannel, ...QrChannel[]]),
    image_base64: z.string().min(1).max(Math.ceil(QR_MAX_BYTES / 3) * 4 + 4),
    mime_type: z.enum(["image/png", "image/jpeg"]),
  })
  .strict();

type Fail = { ok: false; status: number; code: string };
const fail = (status: number, code: string): Fail => ({ ok: false, status, code });

export function sniffImage(b: Uint8Array): "image/png" | "image/jpeg" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

function decodeBase64(s: string): Uint8Array | null {
  const clean = s.replace(/^data:image\/(png|jpeg);base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  return new Uint8Array(Buffer.from(clean, "base64"));
}

const isOwnPath = (locationId: string, channel: QrChannel, p: string | null) =>
  !!p && new RegExp(`^${locationId}/${channel}/[0-9a-f-]{36}\\.(png|jpg)$`).test(p);

export async function printStoreQr(deps: QrPrintDeps, userId: string, body: unknown) {
  const action = (body as { action?: unknown } | null)?.action;
  if (action === "get") {
    const p = Get.safeParse(body);
    if (!p.success) return fail(422, "validation_error");
    const loc = p.data.location_id;
    if (!(await deps.canAccessLocation(userId, loc))) return fail(403, "location_forbidden");
    const [rows, roles] = await Promise.all([deps.list(loc), deps.roles(userId)]);
    const channels: { channel: QrChannel; image_url: string; updated_at: string }[] = [];
    for (const r of rows) {
      const ch = PURPOSE_TO_CHANNEL.get(r.purpose);
      if (!ch || r.status !== "active" || r.image_bucket !== QR_BUCKET || !isOwnPath(loc, ch, r.image_path)) continue;
      const url = await deps.sign(QR_BUCKET, r.image_path!, QR_SIGN_TTL).catch(() => null);
      if (url) channels.push({ channel: ch, image_url: url, updated_at: r.updated_at });
    }
    channels.sort((a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel));
    return { ok: true as const, body: { location_id: loc, channels, can_manage: roles.includes("super_admin") } };
  }
  if (action !== "save") return fail(422, "validation_error");

  // 先鉴权，再解析图片。
  if (!(await deps.roles(userId)).includes("super_admin")) return fail(403, "admin_only");
  const p = Save.safeParse(body);
  if (!p.success) return fail(422, "validation_error");
  const { location_id, channel, mime_type } = p.data;
  const bytes = decodeBase64(p.data.image_base64);
  if (!bytes || bytes.length === 0) return fail(422, "invalid_image");
  if (bytes.length > QR_MAX_BYTES) return fail(422, "image_too_large");
  const real = sniffImage(bytes);
  if (!real || real !== mime_type) return fail(422, "invalid_image");

  const path = `${location_id}/${channel}/${deps.newObjectId()}.${real === "image/png" ? "png" : "jpg"}`;
  try {
    await deps.upload(path, bytes, real);
  } catch {
    return fail(502, "upload_failed");
  }
  let saved: { updated_at: string } | null = null;
  try {
    saved = await deps.saveImage({ location_id, purpose: CHANNEL_TO_PURPOSE[channel], image_path: path, updated_by: userId });
  } catch {
    saved = null;
  }
  if (!saved) {
    await deps.remove(path).catch(() => undefined);
    return fail(500, "save_failed");
  }
  const url = await deps.sign(QR_BUCKET, path, QR_SIGN_TTL).catch(() => null);
  return {
    ok: true as const,
    body: { location_id, channel: { channel, image_url: url, updated_at: saved.updated_at }, can_manage: true },
  };
}
