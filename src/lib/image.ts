/**
 * 把 Supabase Storage 的 public / 签名 URL 转成服务端缩略图（webp）。
 * - /storage/v1/object/public/... → /storage/v1/render/image/public/...
 * - /storage/v1/object/sign/...?token=... → /storage/v1/render/image/sign/...?token=...
 *   （签名 transform 端点复用同一 token，无需重签）
 * 非 Supabase URL 原样返回。
 */
export function toThumbUrl(url: string | null | undefined, width = 256): string | null {
  if (!url) return url ?? null;
  const swap = (from: string, to: string): string | null => {
    if (!url.includes(from)) return null;
    const t = url.replace(from, to);
    const sep = t.includes("?") ? "&" : "?";
    return `${t}${sep}width=${width}&quality=70&resize=contain`;
  };
  return (
    swap("/storage/v1/object/public/", "/storage/v1/render/image/public/") ??
    swap("/storage/v1/object/sign/", "/storage/v1/render/image/sign/") ??
    url
  );
}
