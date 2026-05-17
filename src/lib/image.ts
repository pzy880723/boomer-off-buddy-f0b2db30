/**
 * 把 Supabase Storage 的 public 链接转成服务端缩略图（webp）。
 * 非 Supabase URL 原样返回。
 */
export function toThumbUrl(url: string | null | undefined, width = 256): string | null {
  if (!url) return url ?? null;
  if (url.includes("/storage/v1/object/public/")) {
    const transformed = url.replace(
      "/storage/v1/object/public/",
      "/storage/v1/render/image/public/",
    );
    const sep = transformed.includes("?") ? "&" : "?";
    return `${transformed}${sep}width=${width}&quality=70&resize=contain`;
  }
  return url;
}
