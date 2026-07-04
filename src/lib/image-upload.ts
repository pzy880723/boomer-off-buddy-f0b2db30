// 客户端图片压缩 + 上传工具（提取自 item-image-uploader，供 /m 和 /store 复用）
import { supabase } from "@/integrations/supabase/client";

const MAX_DIM = 1280;
const QUALITY = 0.78;
const SKIP_COMPRESS_BELOW = 80 * 1024;

// ==== 全局 pending 上传计数（供表单页禁用保存按钮） ====
let pendingCount = 0;
const listeners = new Set<() => void>();
export function subscribePendingUploads(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getPendingUploadCount(): number {
  return pendingCount;
}
export function beginPendingUpload(): () => void {
  pendingCount += 1;
  listeners.forEach((l) => l());
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    pendingCount = Math.max(0, pendingCount - 1);
    listeners.forEach((l) => l());
  };
}

export async function compressImage(
  file: File | Blob,
  filename = "image",
): Promise<{ blob: Blob; ext: string; mime: string }> {
  const type = (file as File).type || "image/jpeg";
  const size = (file as File).size ?? file.size ?? 0;
  const passthrough = () => ({
    blob: file as Blob,
    ext: ((filename.split(".").pop() || type.split("/").pop() || "png").toLowerCase()),
    mime: type || "application/octet-stream",
  });
  if (size && size < SKIP_COMPRESS_BELOW) return passthrough();
  if (type === "image/gif" || type === "image/svg+xml" || (type && !type.startsWith("image/"))) {
    return passthrough();
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    let blob: Blob | null = null;
    let mime = "image/webp";

    if (typeof OffscreenCanvas !== "undefined") {
      try {
        const oc = new OffscreenCanvas(w, h);
        const ctx = oc.getContext("2d");
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0, w, h);
          try {
            blob = await oc.convertToBlob({ type: "image/webp", quality: QUALITY });
          } catch {
            blob = await oc.convertToBlob({ type: "image/jpeg", quality: 0.85 });
            mime = "image/jpeg";
          }
        }
      } catch {
        // ignore
      }
    }

    if (!blob) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close?.();
        return passthrough();
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      blob = await new Promise<Blob | null>((r) =>
        canvas.toBlob((b) => r(b), "image/webp", QUALITY),
      );
      if (!blob) {
        blob = await new Promise<Blob | null>((r) =>
          canvas.toBlob((b) => r(b), "image/jpeg", 0.85),
        );
        mime = "image/jpeg";
      }
    }
    bitmap.close?.();

    if (!blob || (size && blob.size >= size)) return passthrough();
    return { blob, ext: mime === "image/webp" ? "webp" : "jpg", mime };
  } catch {
    return passthrough();
  }
}

export async function uploadParcelImage(
  file: File | Blob,
  folder: "items" | "receive" | "sort" | "search" = "items",
  parcelId?: string,
): Promise<string> {
  const BUCKET = "parcel-item-images";
  const { blob, ext, mime } = await compressImage(file, (file as File).name);
  const sub = parcelId ? `${folder}/${parcelId}` : folder;
  const path = `${sub}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    cacheControl: "3600",
    upsert: false,
    contentType: mime,
  });
  if (error) throw new Error(error.message);
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** 上传商品 SKU 图片（复用 parcel-item-images 公共桶的 skus/ 子目录） */
export async function uploadSkuImage(file: File | Blob): Promise<string> {
  const BUCKET = "parcel-item-images";
  const { blob, ext, mime } = await compressImage(file, (file as File).name);
  const path = `skus/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    cacheControl: "3600",
    upsert: false,
    contentType: mime,
  });
  if (error) throw new Error(error.message);
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** 把 Blob 转 base64（不含 data: 前缀），AI 拍照识图用 */
export async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
