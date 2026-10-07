// 员工资料（姓名/头像）纯函数：canonical 为 Auth user_metadata.name 与 avatar_path。
// 不使用 @users.local 技术邮箱或手机号充当姓名。
export const STAFF_AVATAR_BUCKET = "staff-avatars";
export const STAFF_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const STAFF_AVATAR_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
export type StaffAvatarMime = (typeof STAFF_AVATAR_MIME)[number];

export function staffDisplayName(meta: Record<string, unknown> | null | undefined): string | null {
  for (const k of ["name", "display_name", "full_name"]) {
    const v = meta?.[k];
    if (typeof v === "string") {
      const t = v.trim();
      if (t && !t.endsWith("@users.local")) return t;
    }
  }
  return null;
}

/** avatar_path 必须是本桶内服务端生成的 `<userId>/<随机>.<ext>`，拒绝 URL/路径穿越。 */
export function staffAvatarPath(meta: Record<string, unknown> | null | undefined, userId: string): string | null {
  const v = meta?.avatar_path;
  if (typeof v !== "string") return null;
  const re = new RegExp(`^${userId}/[a-z0-9-]{8,64}\\.(png|jpg|webp)$`);
  return re.test(v) ? v : null;
}

/** 按文件头识别真实格式，声明 MIME 不可信。 */
export function sniffAvatarMime(bytes: Uint8Array): StaffAvatarMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export function validateAvatarBytes(bytes: Uint8Array): { ok: true; mime: StaffAvatarMime; ext: "png" | "jpg" | "webp" } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "头像为空" };
  if (bytes.length > STAFF_AVATAR_MAX_BYTES) return { ok: false, error: "头像不能超过 2MB" };
  const mime = sniffAvatarMime(bytes);
  if (!mime) return { ok: false, error: "头像仅支持 PNG / JPG / WEBP" };
  return { ok: true, mime, ext: mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "webp" };
}
