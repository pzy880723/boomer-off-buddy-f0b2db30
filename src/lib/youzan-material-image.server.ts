import { createServerOnlyFn } from "@tanstack/react-start";
import type SharpFn from "sharp";
// Native module loaded on first image use only, so non-image routes can cold-start without it.
const loadSharp = async (): Promise<typeof SharpFn> => (await import("sharp")).default;

const MAX_MATERIAL_BYTES = 3 * 1024 * 1024;

/** Only the upload copy is transformed; the ERP's stored source stays untouched. */
export const prepareYouzanMaterialImage = createServerOnlyFn(async (source: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
  const image = (await loadSharp())(source)
    .rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" });
  for (const quality of [90, 80, 70, 60]) {
    const bytes = await image.clone().jpeg({ quality }).toBuffer();
    if (bytes.byteLength < MAX_MATERIAL_BYTES) return new Uint8Array(bytes);
  }
  throw new Error("ERP 图片压缩后仍超过有赞 3MB 限制");
});
