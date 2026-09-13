/**
 * 消费者端统一压缩衍生图签名器（server-only）。
 *
 * 输入可以是 bucket/path、本项目 Supabase 绝对 URL（object/render、public/sign）、
 * 或腾讯媒体域名下的存储 URL。输出一律是**真实缩放**后的 URL：
 * - 本项目：createSignedUrl(path, ttl, { transform: { width, resize, quality } })
 *   → /storage/v1/render/image/sign/... ；公共桶同样走签名 transform（前端已允许该路径）。
 * - 腾讯：公共桶 render/image/public 直出（见 buildTencentDerivativeUrl 契约）。
 *
 * 任何无法安全解析、无法生成衍生图或签名失败的值 → null，**绝不回退原图**。
 */
import {
  DERIVATIVE_QUALITY,
  DERIVATIVE_RESIZE,
  DERIVATIVE_WIDTHS,
  buildTencentDerivativeUrl,
  isAllowedDerivativeWidth,
  parseStorageRef,
  type StorageRef,
} from "@/lib/media-derivative";

export { DERIVATIVE_WIDTHS };

const SIGNED_TTL = 60 * 60 * 24; // 24h
const CONCURRENCY = 4;

export type DerivativeDeps = {
  /** 本项目 service-role 签名（含 transform）；失败返回 null。 */
  signPrimary?: (ref: StorageRef, width: number) => Promise<string | null>;
  primaryOrigin?: string | null;
  tencentOrigin?: string | null;
  /**
   * 腾讯 render/image/public 衍生能力是否已在腾讯现场实测验证。
   * 未显式置 true（或 env TENCENT_MEDIA_RENDER_VERIFIED=true）时，
   * 腾讯 ref 一律返回 null —— 构造的 URL 未经实测不得当作真实衍生图下发。
   */
  tencentRenderVerified?: boolean;
};

function primaryOriginFromEnv(): string | null {
  return process.env["SUPABASE_URL"]?.trim() || null;
}

function tencentOriginFromEnv(): string | null {
  return process.env["TENCENT_MEDIA_URL"]?.trim() || null;
}

/** 腾讯 render 衍生能力开关：只有实测验证后显式置 "true" 才放行。 */
function tencentRenderVerifiedFromEnv(): boolean {
  return process.env["TENCENT_MEDIA_RENDER_VERIFIED"]?.trim() === "true";
}

async function defaultSignPrimary(ref: StorageRef, width: number): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.storage
      .from(ref.bucket)
      .createSignedUrl(ref.path, SIGNED_TTL, {
        transform: { width, resize: DERIVATIVE_RESIZE, quality: DERIVATIVE_QUALITY },
      });
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * 批量把任意图片值转成指定宽度的衍生图 URL（顺序对齐，失败为 null）。
 * 相同 ref 只签一次。
 */
export async function signDerivativeUrls(
  values: readonly (string | null | undefined)[],
  width: number = DERIVATIVE_WIDTHS.thumbnail,
  deps: DerivativeDeps = {},
): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(values.length).fill(null);
  if (values.length === 0) return out;

  const primaryOrigin = deps.primaryOrigin ?? primaryOriginFromEnv();
  const tencentOrigin = deps.tencentOrigin ?? tencentOriginFromEnv();
  const signPrimary = deps.signPrimary ?? defaultSignPrimary;

  const jobs = new Map<string, { ref: StorageRef; idxs: number[] }>();
  values.forEach((value, idx) => {
    const ref = parseStorageRef(value, { primary: primaryOrigin, tencent: tencentOrigin });
    if (!ref) return;
    if (ref.origin === "tencent") {
      out[idx] = buildTencentDerivativeUrl(ref, width, tencentOrigin);
      return;
    }
    const key = `${ref.bucket}/${ref.path}`;
    const entry = jobs.get(key) ?? { ref, idxs: [] };
    entry.idxs.push(idx);
    jobs.set(key, entry);
  });

  const list = Array.from(jobs.values());
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const job = list[cursor++];
      let url: string | null = null;
      try {
        url = await signPrimary(job.ref, width);
      } catch {
        url = null; // 绝不回退原图
      }
      for (const idx of job.idxs) out[idx] = url;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, () => worker()));
  return out;
}

/** 单值便捷版。 */
export async function signDerivativeUrl(
  value: string | null | undefined,
  width: number = DERIVATIVE_WIDTHS.thumbnail,
  deps: DerivativeDeps = {},
): Promise<string | null> {
  return (await signDerivativeUrls([value], width, deps))[0] ?? null;
}
