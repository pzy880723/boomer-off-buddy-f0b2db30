import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  isSuperAdminPhone,
  PHONE_REGEX,
  phoneToEmail,
  emailToPhone,
} from "./auth-config";
import { STAFF_AVATAR_BUCKET, STAFF_AVATAR_MAX_BYTES, staffAvatarPath, validateAvatarBytes } from "./staff-profile";

function admin() {
  const url = process.env.SUPABASE_URL!;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEYS ||
    "";
  return createClient(url, key, { auth: { persistSession: false } });
}

async function assertSuperAdmin(context: { supabase: { auth: { getUser: () => Promise<any> } } }) {
  const { data, error } = await context.supabase.auth.getUser();
  if (error || !data?.user) throw new Error("未登录");
  const u = data.user;
  const phone = emailToPhone(u.email) || u.phone || u.user_metadata?.phone;
  if (!isSuperAdminPhone(phone)) throw new Error("无权操作：仅超级管理员可管理账号");
  return u;
}

// ===== 列出所有用户 =====
export const listUsersFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context as any);
    const sb = admin();
    const all: any[] = [];
    let page = 1;
    while (true) {
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(error.message);
      all.push(...data.users);
      if (data.users.length < 200) break;
      page += 1;
    }
    const signed = await Promise.all(
      all.map(async (u) => {
        const path = staffAvatarPath(u.user_metadata, u.id);
        if (!path) return null;
        const { data } = await sb.storage.from(STAFF_AVATAR_BUCKET).createSignedUrl(path, 3600);
        return data?.signedUrl ?? null;
      }),
    );
    return all
      .map((u, i) => {
        const derivedPhone = emailToPhone(u.email) || u.phone || null;
        // 如果 email 是伪邮箱，UI 不显示原 email
        const visibleEmail = emailToPhone(u.email) ? null : u.email ?? null;
        return {
          id: u.id,
          phone: derivedPhone,
          email: visibleEmail,
          name: (u.user_metadata?.name as string | undefined) ?? null,
          avatar_url: signed[i] as string | null,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at ?? null,
          must_change_password: !!u.user_metadata?.must_change_password,
        };
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  });

// ===== 创建用户 =====
const createSchema = z.object({
  phone: z.string().regex(PHONE_REGEX, "手机号格式不正确"),
  password: z.string().min(6, "密码至少 6 位").max(72),
  name: z.string().trim().min(1, "请填写姓名").max(50, "姓名过长"),
});

export const createUserFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => createSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context as any);
    const sb = admin();
    const { data: created, error } = await sb.auth.admin.createUser({
      email: phoneToEmail(data.phone),
      password: data.password,
      email_confirm: true,
      user_metadata: {
        phone: data.phone,
        name: data.name,
        must_change_password: true,
      },
    });
    if (error) throw new Error(error.message);
    return { id: created.user?.id };
  });

// ===== 更新姓名 =====
const updateNameSchema = z.object({
  userId: z.string().uuid(),
  name: z.string().trim().min(1, "请填写姓名").max(50, "姓名过长"),
});

export const updateUserNameFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => updateNameSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context as any);
    const sb = admin();
    const { data: cur, error: getErr } = await sb.auth.admin.getUserById(data.userId);
    if (getErr) throw new Error(getErr.message);
    const meta = { ...(cur.user?.user_metadata ?? {}), name: data.name };
    const { error } = await sb.auth.admin.updateUserById(data.userId, {
      user_metadata: meta,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ===== 重置密码（管理员） =====
const resetSchema = z.object({
  userId: z.string().uuid(),
  password: z.string().min(6).max(72),
});

export const resetUserPasswordFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => resetSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context as any);
    const sb = admin();
    const { error } = await sb.auth.admin.updateUserById(data.userId, {
      password: data.password,
      user_metadata: { must_change_password: true },
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ===== 删除用户 =====
const deleteSchema = z.object({ userId: z.string().uuid() });

export const deleteUserFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => deleteSchema.parse(input))
  .handler(async ({ data, context }) => {
    const me = await assertSuperAdmin(context as any);
    if (me.id === data.userId) throw new Error("不能删除自己");
    const sb = admin();
    const { error } = await sb.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ===== 头像（仅超级管理员，服务端校验格式/大小，私有桶） =====
const avatarSchema = z.object({
  userId: z.string().uuid(),
  // base64（不含 data: 前缀）；2MB 原始字节 ≈ 2.8M 字符
  base64: z.string().min(1).max(Math.ceil((STAFF_AVATAR_MAX_BYTES * 4) / 3) + 8),
});

export const setUserAvatarFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => avatarSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context as any);
    let bytes: Uint8Array;
    try {
      const bin = atob(data.base64);
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      throw new Error("头像数据无效");
    }
    const v = validateAvatarBytes(bytes);
    if (!v.ok) throw new Error(v.error);
    const sb = admin();
    const { data: cur, error: getErr } = await sb.auth.admin.getUserById(data.userId);
    if (getErr || !cur.user) throw new Error("账号不存在");
    const path = `${data.userId}/${crypto.randomUUID()}.${v.ext}`;
    const { error: upErr } = await sb.storage
      .from(STAFF_AVATAR_BUCKET)
      .upload(path, bytes, { contentType: v.mime, upsert: false });
    if (upErr) throw new Error("头像上传失败");
    const oldPath = staffAvatarPath(cur.user.user_metadata, data.userId);
    const meta = { ...(cur.user.user_metadata ?? {}), avatar_path: path };
    const { error } = await sb.auth.admin.updateUserById(data.userId, { user_metadata: meta });
    if (error) {
      await sb.storage.from(STAFF_AVATAR_BUCKET).remove([path]);
      throw new Error("头像保存失败");
    }
    if (oldPath && oldPath !== path) await sb.storage.from(STAFF_AVATAR_BUCKET).remove([oldPath]);
    return { ok: true };
  });

export const removeUserAvatarFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ userId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context as any);
    const sb = admin();
    const { data: cur, error: getErr } = await sb.auth.admin.getUserById(data.userId);
    if (getErr || !cur.user) throw new Error("账号不存在");
    const oldPath = staffAvatarPath(cur.user.user_metadata, data.userId);
    const meta = { ...(cur.user.user_metadata ?? {}), avatar_path: null };
    const { error } = await sb.auth.admin.updateUserById(data.userId, { user_metadata: meta });
    if (error) throw new Error("头像移除失败");
    if (oldPath) await sb.storage.from(STAFF_AVATAR_BUCKET).remove([oldPath]);
    return { ok: true };
  });
