import { createServerOnlyFn } from "@tanstack/react-start";
import sharp from "sharp";

const MAX_MATERIAL_BYTES = 3 * 1024 * 1024;

/** Only the upload copy is transformed; the ERP's stored source stays untouched. */
export const prepareYouzanMaterialImage = createServerOnlyFn(async (source: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
  const image = sharp(source)
    .rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" });
  for (const quality of [90, 80, 70, 60]) {
    const bytes = await image.clone().jpeg({ quality }).toBuffer();
    if (bytes.byteLength < MAX_MATERIAL_BYTES) return new Uint8Array(bytes);
  }
  throw new Error("ERP 图片压缩后仍超过有赞 3MB 限制");
});
