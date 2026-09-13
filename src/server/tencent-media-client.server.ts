/**
 * 第二个 server-only Supabase client：指向腾讯 COS-backed Supabase Storage。
 * 只用于 parcel-item-images 公共桶的对象写入 / 公开 URL 生成。
 * 主 supabaseAdmin（业务库 + auth）保持不变，仍在 Lovable。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  PARCEL_MEDIA_BUCKET,
  REQUIRED_TENCENT_MEDIA_URL,
  type TencentMediaUploader,
} from "./parcel-media-upload.server";

let cached: SupabaseClient | null = null;
let cachedKey = "";

/** 缺 env 或端点不是固定的腾讯媒体域名时返回 null（维持原 Lovable 上传） */
export function tencentMediaUploader(): TencentMediaUploader | null {
  const url = process.env["TENCENT_MEDIA_URL"]?.trim();
  const key = process.env["TENCENT_MEDIA_SERVICE_ROLE_KEY"]?.trim();
  if (!url || !key) return null;
  if (url !== REQUIRED_TENCENT_MEDIA_URL) {
    console.error("[tencent-media] TENCENT_MEDIA_URL is not the allowed endpoint; upload disabled");
    return null;
  }

  if (!cached || cachedKey !== key) {
    cached = createClient(url, key, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    });
    cachedKey = key;
  }
  const client = cached;

  return {
    async upload(path, bytes, contentType) {
      const { error } = await client.storage.from(PARCEL_MEDIA_BUCKET).upload(path, bytes, {
        cacheControl: "3600",
        upsert: false,
        contentType,
      });
      return { error: error ?? null };
    },
    publicUrl(path) {
      return client.storage.from(PARCEL_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
    },
  };
}
