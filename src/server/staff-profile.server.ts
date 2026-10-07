// 服务端读取员工 canonical 资料：每次实时读 Auth user_metadata（不信陈旧 JWT），头像读时签名。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { STAFF_AVATAR_BUCKET, staffAvatarPath, staffDisplayName } from "@/lib/staff-profile";

export const STAFF_AVATAR_SIGN_SECONDS = 6 * 3600;

export type StaffProfile = { user_id: string; display_name: string | null; avatar_url: string | null };

export async function signStaffAvatar(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(STAFF_AVATAR_BUCKET)
    .createSignedUrl(path, STAFF_AVATAR_SIGN_SECONDS);
  return error || !data?.signedUrl ? null : data.signedUrl;
}

export function profileFromUser(user: { id: string; user_metadata?: Record<string, unknown> | null }) {
  return {
    user_id: user.id,
    display_name: staffDisplayName(user.user_metadata),
    avatar_path: staffAvatarPath(user.user_metadata, user.id),
  };
}

/** 查询失败抛错（不返回伪造资料）；用户不存在返回 null。 */
export async function loadStaffProfile(userId: string): Promise<StaffProfile | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error && !/not found/i.test(error.message)) throw new Error("profile_unavailable");
  if (!data?.user) return null;
  const p = profileFromUser(data.user);
  return { user_id: p.user_id, display_name: p.display_name, avatar_url: await signStaffAvatar(p.avatar_path) };
}

/** 从 ERP Bearer 实时解析用户；无效返回 null。 */
export async function resolveErpBearerUser(request: Request): Promise<string | null> {
  const raw = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!raw) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(raw);
  return error || !data?.user ? null : data.user.id;
}
