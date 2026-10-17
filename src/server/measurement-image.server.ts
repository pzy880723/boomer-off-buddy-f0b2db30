/**
 * 尺寸素材图（透明 PNG）服务端校验与衍生。
 * 原则：不拉伸、不猜尺寸、不伪造；几何必须与已实测尺寸一致（高宽比误差 ≤3%），
 * alpha 必须真实透明，bbox 由实际像素 trim 得出。失败一律拒绝让重拍。
 */
import sharp from "sharp";

export const MEASUREMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MEASUREMENT_IMAGE_MAX_PX = 2000;
export const MEASUREMENT_RATIO_TOLERANCE = 0.03;

export type MeasurementImageError =
  | "not_png"
  | "too_large"
  | "too_big_dimensions"
  | "no_alpha"
  | "empty_foreground"
  | "ratio_mismatch"
  | "missing_measurement";

export interface ValidatedMeasurementImage {
  /** trim 后前景 bbox（相对原图） */
  bbox: { x: number; y: number; w: number; h: number };
  frontWidthPx: number;
  frontHeightPx: number;
  /** 实测高（cm）/ bbox 高（px）→ 每厘米像素数 */
  pxPerCm: number;
  /** trim 后的透明 PNG 原图 buffer */
  trimmedPng: Buffer;
}

/**
 * 校验透明 PNG 并提取几何：
 * - 必须是 PNG、≤2000px、有真实 alpha 透明区域；
 * - trim 透明边得前景 bbox；
 * - 实测 height 必填，width 缺失时用 diameter 代替；bbox 高宽比与实测比误差 ≤3%。
 */
export async function validateMeasurementImage(
  png: Buffer,
  measured: { height_cm: number | null; width_cm: number | null; diameter_cm: number | null },
): Promise<{ ok: true; value: ValidatedMeasurementImage } | { ok: false; error: MeasurementImageError }> {
  if (png.length > MEASUREMENT_IMAGE_MAX_BYTES) return { ok: false, error: "too_large" };

  let meta: sharp.Metadata;
  try {
    meta = await sharp(png).metadata();
  } catch {
    return { ok: false, error: "not_png" };
  }
  if (meta.format !== "png") return { ok: false, error: "not_png" };
  if (!meta.width || !meta.height) return { ok: false, error: "not_png" };
  if (meta.width > MEASUREMENT_IMAGE_MAX_PX || meta.height > MEASUREMENT_IMAGE_MAX_PX) {
    return { ok: false, error: "too_big_dimensions" };
  }
  if (!meta.hasAlpha) return { ok: false, error: "no_alpha" };

  // 真实透明校验：alpha 通道必须存在接近全透明的像素
  const stats = await sharp(png).stats();
  const alpha = stats.channels[3];
  if (!alpha || alpha.min > 32) return { ok: false, error: "no_alpha" };

  const measuredHeight = measured.height_cm;
  const measuredWidth = measured.width_cm ?? measured.diameter_cm;
  if (measuredHeight == null || measuredWidth == null) {
    return { ok: false, error: "missing_measurement" };
  }

  // trim 透明边（阈值 10，去掉近透明噪点）
  const trimmed = await sharp(png).trim({ threshold: 10 }).toBuffer();
  const tMeta = await sharp(trimmed).metadata();
  if (!tMeta.width || !tMeta.height) return { ok: false, error: "empty_foreground" };

  // bbox 相对原图：用 trim 前后尺寸差计算（trim 居中裁边近似）
  // 精确 bbox：对 alpha 通道找非零边界
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { ok: false, error: "empty_foreground" };
  const bbox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };

  const imageRatio = bbox.h / bbox.w;
  const measuredRatio = measuredHeight / measuredWidth;
  if (Math.abs(imageRatio - measuredRatio) / measuredRatio > MEASUREMENT_RATIO_TOLERANCE) {
    return { ok: false, error: "ratio_mismatch" };
  }

  return {
    ok: true,
    value: {
      bbox,
      frontWidthPx: bbox.w,
      frontHeightPx: bbox.h,
      pxPerCm: Math.round((bbox.h / measuredHeight) * 1000) / 1000,
      trimmedPng: trimmed,
    },
  };
}

/** 生成受控透明 PNG 衍生（640/1280 宽，不放大、不拉伸） */
export async function deriveMeasurementPngs(
  trimmedPng: Buffer,
): Promise<{ png640: Buffer; png1280: Buffer }> {
  const meta = await sharp(trimmedPng).metadata();
  const w = meta.width ?? 0;
  const resize = async (target: number) =>
    w <= target
      ? sharp(trimmedPng).png().toBuffer()
      : sharp(trimmedPng).resize({ width: target, withoutEnlargement: true }).png().toBuffer();
  const [png640, png1280] = await Promise.all([resize(640), resize(1280)]);
  return { png640, png1280 };
}
