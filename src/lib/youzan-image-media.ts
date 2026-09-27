import { resolvePublicSkuImageUrls } from "./sku-media";

export const YOUZAN_CHANNEL_IMAGE_LIMIT = 5;

export function buildHqImageParams(spuId: number, images: string[]) {
  if (!Number.isSafeInteger(spuId) || spuId <= 0 || !images.length || images.length > 10)
    throw new Error("HQ media requires a valid SPU and one to ten images");
  return {
    spu_id: spuId,
    photo_url: JSON.stringify(images.map(url => ({ url }))),
  };
}

export function imageRefreshSources(sku: { image_paths?: string[] | null; image_url?: string | null }, origin: string) {
  const paths = sku.image_paths?.length ? sku.image_paths : [sku.image_url].filter((v): v is string => Boolean(v));
  if (paths.some(path => path.startsWith("sku-raw/"))) throw new Error("listing_images_pending");
  const urls = resolvePublicSkuImageUrls(paths, origin, paths.length);
  if (!urls.length || urls.length !== new Set(paths).size)
    throw new Error("Image refresh requires valid images");
  return urls;
}
