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
    return all
      .map((u) => {
        const derivedPhone = emailToPhone(u.email) || u.phone || null;
        // 如果 email 是伪邮箱，UI 不显示原 email
        const visibleEmail = emailToPhone(u.email) ? null : u.email ?? null;
        return {
          id: u.id,
          phone: derivedPhone,
          email: visibleEmail,
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
      user_metadata: { phone: data.phone, must_change_password: true },
    });
    if (error) throw new Error(error.message);
    return { id: created.user?.id };
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
