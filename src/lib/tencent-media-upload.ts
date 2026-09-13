/**
 * 浏览器侧：公开桶 parcel-item-images 上传的腾讯切换开关与同源上传调用。
 * 开关默认 off；开关打开时腾讯失败必须报错，不得偷偷回退 Lovable。
 */
import { supabase } from "@/integrations/supabase/client";

export const PARCEL_UPLOAD_ENDPOINT = "/api/internal/media/parcel-upload";

export type ParcelUploadFolder = "items" | "receive" | "sort" | "search" | "skus";

/** 纯函数便于单测：仅字符串 'true' 才启用 */
export function shouldUseTencentMediaUploads(env: Record<string, unknown> | undefined): boolean {
  return env?.["VITE_TENCENT_MEDIA_UPLOADS"] === "true";
}

export function tencentMediaUploadsEnabled(): boolean {
  return shouldUseTencentMediaUploads(
    (import.meta as unknown as { env?: Record<string, unknown> }).env,
  );
}

export type TencentUploadDeps = {
  getAccessToken(): Promise<string | null>;
  fetchImpl: typeof fetch;
};

const defaultDeps: TencentUploadDeps = {
  async getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  },
  fetchImpl: (...args) => fetch(...args),
};

export async function uploadParcelBlobViaTencent(
  blob: Blob,
  folder: ParcelUploadFolder,
  parcelId?: string | null,
  deps: TencentUploadDeps = defaultDeps,
): Promise<string> {
  const token = await deps.getAccessToken();
  if (!token) throw new Error("请先登录后再上传图片");

  const body = new FormData();
  body.set("folder", folder);
  if (parcelId) body.set("parcel_id", parcelId);
  body.set("file", blob, "upload");

  const res = await deps.fetchImpl(PARCEL_UPLOAD_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  if (!res.ok) {
    let code = "";
    try {
      code = String(((await res.json()) as { error?: string })?.error ?? "");
    } catch {
      code = "";
    }
    throw new Error(`图片上传失败（${res.status}${code ? ` ${code}` : ""}）`);
  }
  const data = (await res.json()) as { url?: string };
  if (!data.url) throw new Error("图片上传失败（无返回地址）");
  return data.url;
}
