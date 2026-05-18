
## 问题定位

登录请求返回：
```
422  {"code":"phone_provider_disabled","message":"Phone logins are disabled"}
```

Supabase 的 Phone Provider 默认关闭，需要在 Cloud 控制台手动开启才能用 `signInWithPassword({ phone })`。这正是你说的"搞这么复杂"的源头。

## 解决思路：用户层看到手机号，底层走邮箱

Email Provider 是 Supabase 永远开着的（不需要任何配置）。我们把手机号在内部映射成一个伪邮箱：

```
手机号 18657433310  ⇄  内部邮箱 18657433310@users.local
```

- 界面、菜单、列表 **一律只显示手机号**
- 数据库底层用 email + password 登录，永远不会再撞到 Phone Provider 开关
- 不需要短信通道、不需要任何 Cloud 控制台操作

## 改动清单

### 1. 现有 `18657433310` 账号迁移
当前这个用户是用 phone 字段创建的，要给它补一个 email：

```sql
update auth.users
   set email = '18657433310@users.local',
       email_confirmed_at = coalesce(email_confirmed_at, now())
 where phone = '18657433310';

insert into auth.identities (id, user_id, provider, provider_id,
                              identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), id, 'email', id::text,
       jsonb_build_object('sub', id::text, 'email', '18657433310@users.local',
                          'email_verified', true),
       now(), now(), now()
  from auth.users
 where phone = '18657433310'
   and not exists (
     select 1 from auth.identities
      where user_id = auth.users.id and provider = 'email'
   );
```

密码 `pzy5565283` 保持不变（`encrypted_password` 不动）。

### 2. 工具函数 `src/lib/auth-config.ts`
新增 phone ↔ 伪邮箱互转：

```ts
export const FAKE_EMAIL_DOMAIN = "users.local";
export const phoneToEmail = (phone: string) => `${phone}@${FAKE_EMAIL_DOMAIN}`;
export const emailToPhone = (email?: string | null) =>
  email?.endsWith(`@${FAKE_EMAIL_DOMAIN}`) ? email.split("@")[0] : null;
```

`SUPER_ADMIN_PHONES` 和 `isSuperAdminPhone` 保留不变。

### 3. `src/routes/login.tsx`
登录改成：
```ts
await supabase.auth.signInWithPassword({
  email: phoneToEmail(cleanPhone),
  password,
});
```
界面完全不变，用户仍然只看到"手机号 + 密码"。

### 4. `src/lib/admin-users.functions.ts`
- `createUserFn`：改用 `sb.auth.admin.createUser({ email: phoneToEmail(phone), password, email_confirm: true, user_metadata: { phone, must_change_password: true } })`
- `listUsersFn` 返回时把 email 反解成 phone 显示（旧的真邮箱账号如 `87113911@qq.com` 显示原邮箱）
- `resetUserPasswordFn`、`deleteUserFn` 无需改动

### 5. `src/routes/__root.tsx` UserMenu
判定超管和显示名都改成读 `emailToPhone(session.user.email) ?? session.user.phone`，让迁移后的账号也能正确识别。

### 6. `src/routes/admin/users.tsx`
列表"手机号"列优先显示 `emailToPhone(email) ?? phone ?? email`。

## 你需要做什么
1. **批准这个 plan** → 我直接动手
2. 改完后 **点右上角 Update 重新发布一次**，让正式站点拿到新代码
3. 老邮箱账号 `87113911@qq.com` 不动，仍可用邮箱方式登录（如果你想保留这条后门，需要登录页同时支持邮箱；如果不想，就只能从 UI 入口用手机号 —— 我建议先不开后门，需要的时候随时加）

确认就开干。
