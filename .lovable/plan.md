## 目标

- 给整个 ERP 后台加上"必须登录才能访问"的门禁
- **关闭自助注册**：用户只能由管理员在后台/数据库添加
- 预置管理员账号：`87113911@qq.com` / `pzy5565283`（自动确认邮箱，免去验证邮件流程）
- 设计一个好看、品牌感强的登录页 `/login`

---

## 一、后端：认证开关 + 预置管理员

1. **`configure_auth`**：`disable_signup: true`、`auto_confirm_email: true`、`external_anonymous_users_enabled: false`、`password_hibp_enabled: false`
   - 关闭后，普通用户调用 `supabase.auth.signUp` 会被服务端拒绝
   - 管理员通过 service-role `auth.admin.createUser` 仍可建号

2. **创建一次性 bootstrap 接口**：`src/routes/api/public/bootstrap-admin.ts`（GET）
   - 用 `supabaseAdmin.auth.admin.listUsers` 查 `87113911@qq.com` 是否存在
   - 不存在则 `auth.admin.createUser({ email, password: 'pzy5565283', email_confirm: true })`
   - 已存在则直接返回 `{ ok: true, already: true }`
   - 幂等、无副作用；部署后访问一次即可，之后可保留或删除

3. **后续添加用户**：在 `/settings` 或新建 `/users` 页（本次先不做完整 UI），临时让用户在 Supabase 数据库后台 / Lovable Cloud Users 面板手动添加。本次只做 bootstrap 管理员 + 登录流程。

> 不引入 user roles 表、不做 RBAC、不做 profiles 表（用户没要求；现有 RLS 全是 `true` 也用不上）。

---

## 二、前端：登录页 + 路由守卫

### 1. 新增 `src/routes/login.tsx`
- 公开路由，不在主壳 (sidebar + header) 内
- 已登录访问 `/login` 自动 redirect 到 `/dashboard`
- 表单：邮箱 + 密码 + "登录" 按钮 + 错误提示（toast / 内联）
- 调 `supabase.auth.signInWithPassword`

**视觉设计**（紧贴现有品牌：BOOMER OFF · 已有 `bg-gradient-brand` 等 token）：
- 全屏分栏：
  - **左侧（≥md）**：品牌侧栏，深色背景，覆盖品牌渐变 + 噪点 / 模糊光晕；顶部 BOOMER OFF logo，中部一句 slogan "中古杂货 · 全链路 ERP"，底部三条"为什么用 BOOMER OFF"小亮点（含 lucide icon），右下角一行版权
  - **右侧**：白底（dark 模式跟随），居中一张 `Card`，最大宽 400px：标题"欢迎回来"、副标题"使用管理员账号登录"、Email/Password 两个 `Input`（带 lucide 前缀 icon）、Remember 复选框、登录按钮（默认 variant，full width，loading 态有 spinner）、底部一行 "账号由管理员添加"小字
- 细节：圆角 `rounded-2xl`、卡片有 `shadow-elegant` token、按钮 hover 微缩放、表单整体 `space-y-4`、错误用 `text-destructive` 行内提示
- 移动端：左侧栏隐藏，右侧表单独占，顶部留 logo

### 2. 在 `src/routes/__root.tsx` 增加 `AuthGate`
不重排现有路由文件（成本太高）。改 `RootComponent` 流程：
```
useEffect: supabase.auth.onAuthStateChange + getSession 同步 session
- 若当前 pathname === "/login" → 直接 <Outlet />（不渲染 sidebar/header 壳）
- 若 session 加载中 → 全屏 loading
- 若无 session 且不在 /login → router.navigate({ to: "/login" })
- 否则正常渲染现有壳 + <Outlet />
```
session 状态用一个轻量 `useAuthSession()` hook（新建 `src/hooks/use-auth-session.ts`）封装。

### 3. 顶部用户菜单
- `src/routes/__root.tsx` 顶栏 Avatar 区：
  - `AvatarFallback` 显示 session 邮箱首字母（不再写死"管"）
  - 旁边显示 `session.user.email`（lg 屏才显示）
  - 下拉里"退出登录"接 `supabase.auth.signOut()` + 跳 `/login`

---

## 三、文件清单

新增：
- `src/routes/login.tsx`
- `src/routes/api/public/bootstrap-admin.ts`
- `src/hooks/use-auth-session.ts`

修改：
- `src/routes/__root.tsx`（加 AuthGate、邮箱头像、退出登录）

工具调用：
- `supabase--configure_auth`（关闭 signup、开启 auto_confirm）

---

## 四、部署后用户需要做的事

1. 等本次改动构建上线
2. 浏览器访问一次 `https://<your-domain>/api/public/bootstrap-admin` → 看到 `{ ok: true }` 即可
3. 之后访问任何页面会被引到 `/login`，用 `87113911@qq.com` / `pzy5565283` 登录

---

## 五、不在本次范围

- 用户管理 UI（增删用户、改密码、角色权限）
- Google / 第三方登录
- 找回密码 / 重置密码页（关闭 signup + 内部系统，暂不需要；后续要可再加）
- RLS 改造（当前所有表都是 `true` 开放策略，加登录后访问者依然是 anon key + publishable，业务表读写不变）

## 风险与兜底

- bootstrap 接口被外部访问最坏情况：会创建一个固定邮箱+固定密码的账号，因为是用户指定的凭证，泄露风险等同于这份密码本身的强度。如果担心，登录后立即在 Supabase 控制台改密码或删除该路由文件再重新部署
- `disable_signup` 同时也会阻塞 bootstrap 走的 `signUp` 路径，但我们用的是 service-role `auth.admin.createUser`，不受影响
