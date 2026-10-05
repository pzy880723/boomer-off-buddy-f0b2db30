/**
 * iOS 兼容入口 POST /api/public/handheld/print/store-qr 的核心逻辑（依赖注入便于测试）。
 * - get：门店读权限；仅返回 active 且有原图的渠道（短签名 URL），停用/缺码不返回、不替用。
 * - save：先鉴权（仅 super_admin），再验 PNG/JPEG 真实魔数与 ≤15MB，原始字节不重绘；
 *   对象路径由服务端生成 {location}/{channel}/{uuid}.{ext}，不接受外部 image_path。
 *   DB 失败时只清理本次新对象；旧对象从不删除（其他版本可能仍引用）。
 */
import { z } from "zod";
import sharp from "sharp";
import type { QrRow } from "./store-qr.server";

export const QR_BUCKET = "store-qr";
export const QR_MAX_BYTES = 15_000_000; // 与 iOS 一致（十进制字节，非 MiB）
export const QR_MAX_PIXELS = 40_000_000;
/** JSON 请求体上限：base64 膨胀 + 少量字段余量。 */
export const QR_MAX_BODY_BYTES = Math.ceil(QR_MAX_BYTES / 3) * 4 + 4096;

/** 完整解码校验（不修改原字节）；格式须与魔数一致，像素总量受限。 */
export async function decodeCheck(bytes: Uint8Array, mime: "image/png" | "image/jpeg"): Promise<boolean> {
  try {
    const img = sharp(bytes, { limitInputPixels: QR_MAX_PIXELS, failOn: "truncated" });
    const meta = await img.metadata();
    if ((mime === "image/png" ? "png" : "jpeg") !== meta.format) return false;
    if (!meta.width || !meta.height) return false;
    const { info } = await img.raw().toBuffer({ resolveWithObject: true });
    return info.width === meta.width && info.height === meta.height;
  } catch {
    return false;
  }
}
export const QR_SIGN_TTL = 300;

/** 大众点评打卡码与评价码完全独立，互不替用。 */
export const CHANNEL_TO_PURPOSE = {
  wechat: "wecom_contact", // 门店个人/企微联系码，非公众号
  xiaohongshu: "xiaohongshu",
  dianping_checkin: "dianping_checkin",
  dianping_review: "dianping_review",
  identify: "identify",
  miniprogram: "mini_program",
} as const;
export type QrChannel = keyof typeof CHANNEL_TO_PURPOSE;
const CHANNELS = Object.keys(CHANNEL_TO_PURPOSE) as QrChannel[];
const PURPOSE_TO_CHANNEL = new Map(Object.entries(CHANNEL_TO_PURPOSE).map(([c, p]) => [p as string, c as QrChannel]));
/** 旧客户端渠道名：dianping 仅等同于评价码（新天地历史记录即评价码），绝不当打卡码。 */
const LEGACY_CHANNEL = "dianping" as const;
const SAVE_CHANNELS = [...CHANNELS, LEGACY_CHANNEL] as const;
/** 展示文案：打卡卡允许宣传收藏打卡赠品（到收银台领取）；评价卡必须保持中性，禁止任何赠品/奖励/领取或字数要求。 */
export const CHANNEL_LABELS: Partial<Record<QrChannel, { title: string; caption: string }>> = {
  dianping_checkin: { title: "收藏打卡送冰箱贴", caption: "完成收藏打卡后，到收银台领取" },
  dianping_review: { title: "诚邀您点评", caption: "欢迎分享真实体验" },
};

export type QrPrintDeps = {
  canAccessLocation(userId: string, locationId: string): Promise<boolean>;
  roles(userId: string): Promise<string[]>;
  list(locationId: string): Promise<QrRow[]>;
  sign(bucket: string, path: string, ttl: number): Promise<string | null>;
  upload(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  remove(path: string): Promise<void>;
  saveImage(row: { location_id: string; purpose: string; image_path: string; updated_by: string }): Promise<{ updated_at: string } | null>;
  newObjectId(): string;
  decode?(bytes: Uint8Array, mime: "image/png" | "image/jpeg"): Promise<boolean>;
};

const Get = z.object({ action: z.literal("get"), location_id: z.string().uuid() }).strict();
const Save = z
  .object({
    action: z.literal("save"),
    location_id: z.string().uuid(),
    channel: z.enum(SAVE_CHANNELS as unknown as [string, ...string[]]),
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

const pathRe = (locationId: string, folder: string) => new RegExp(`^${locationId}/${folder}/[0-9a-f-]{36}\\.(png|jpg)$`);
/** 评价码额外接受历史 {loc}/dianping/ 目录（迁移 0033 保留原对象）；打卡码只认自身目录。 */
const isOwnPath = (locationId: string, channel: QrChannel, p: string | null) =>
  !!p && (pathRe(locationId, channel).test(p) || (channel === "dianping_review" && pathRe(locationId, LEGACY_CHANNEL).test(p)));

type ChannelOut = { channel: QrChannel | typeof LEGACY_CHANNEL; image_url: string; updated_at: string; title?: string; caption?: string; legacy_alias_of?: QrChannel };

export async function printStoreQr(deps: QrPrintDeps, userId: string, body: unknown) {
  const action = (body as { action?: unknown } | null)?.action;
  if (action === "get") {
    const p = Get.safeParse(body);
    if (!p.success) return fail(422, "validation_error");
    const loc = p.data.location_id;
    if (!(await deps.canAccessLocation(userId, loc))) return fail(403, "location_forbidden");
    const [rows, roles] = await Promise.all([deps.list(loc), deps.roles(userId)]);
    const channels: ChannelOut[] = [];
    for (const r of rows) {
      const ch = PURPOSE_TO_CHANNEL.get(r.purpose);
      if (!ch || r.status !== "active" || r.image_bucket !== QR_BUCKET || !isOwnPath(loc, ch, r.image_path)) continue;
      const url = await deps.sign(QR_BUCKET, r.image_path!, QR_SIGN_TTL).catch(() => null);
      if (url) channels.push({ channel: ch, image_url: url, updated_at: r.updated_at, ...CHANNEL_LABELS[ch] });
    }
    channels.sort((a, b) => CHANNELS.indexOf(a.channel as QrChannel) - CHANNELS.indexOf(b.channel as QrChannel));
    // 旧客户端兼容：仅当评价码存在时附加 dianping 别名（排在最后，新客户端应忽略）；打卡码永不作别名。
    const review = channels.find((c) => c.channel === "dianping_review");
    if (review) channels.push({ ...review, channel: LEGACY_CHANNEL, legacy_alias_of: "dianping_review" });
    return { ok: true as const, body: { location_id: loc, channels, can_manage: roles.includes("super_admin") } };
  }
  if (action !== "save") return fail(422, "validation_error");

  // 先鉴权，再解析图片。
  if (!(await deps.roles(userId)).includes("super_admin")) return fail(403, "admin_only");
  const p = Save.safeParse(body);
  if (!p.success) return fail(422, "validation_error");
  const { location_id, mime_type } = p.data;
  const channel: QrChannel = p.data.channel === LEGACY_CHANNEL ? "dianping_review" : (p.data.channel as QrChannel);
  const bytes = decodeBase64(p.data.image_base64);
  if (!bytes || bytes.length === 0) return fail(422, "invalid_image");
  if (bytes.length > QR_MAX_BYTES) return fail(422, "image_too_large");
  const real = sniffImage(bytes);
  if (!real || real !== mime_type) return fail(422, "invalid_image");
  if (!(await (deps.decode ?? decodeCheck)(bytes, real))) return fail(422, "invalid_image");

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

export const TOO_LARGE = Symbol("too_large");
/** 先看 Content-Length，再按流累计字节，超限立即中止，避免整包读入。 */
export async function readJsonCapped(request: Request, max: number): Promise<unknown> {
  const len = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > max) return TOO_LARGE;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return TOO_LARGE; }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { return null; }
}

