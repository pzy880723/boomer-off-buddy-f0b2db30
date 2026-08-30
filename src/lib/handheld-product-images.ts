export type ProductImageItem = {
  id: string;
  image_paths: string[];
  image_url?: string | null;
  images?: { storage_path: string; read_url: string }[];
};

export function collectUniqueProductImagePaths(items: readonly ProductImageItem[]): string[] {
  return [...new Set(items.flatMap((item) => item.image_paths).filter(Boolean))];
}

export function mergeSignedProductImages<T extends ProductImageItem>(
  items: readonly T[],
  signedByPath: ReadonlyMap<string, string>,
): T[] {
  return items.map((item) => {
    const images = item.image_paths.flatMap((storagePath) => {
      const readURL = signedByPath.get(storagePath);
      return readURL ? [{ storage_path: storagePath, read_url: readURL }] : [];
    });
    return {
      ...item,
      image_url: images[0]?.read_url ?? item.image_url ?? null,
      images,
    };
  });
}
