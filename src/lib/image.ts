/**
 * 把 Supabase Storage 的 public URL 转成服务端缩略图。
 * - /storage/v1/object/public/... → /storage/v1/render/image/public/...
 * 私桶签名 URL 原样保留；transform 参数必须在服务端签名时指定，不能在客户端改写。
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
    url
  );
}
