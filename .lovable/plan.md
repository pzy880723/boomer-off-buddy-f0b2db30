## 登录页改造：手机号 + 密码登录，并完整优化失败提示 / 小眼睛 / 跳转流畅度

### 0. 登录方式切换：邮箱 → 手机号（现阶段只做密码登录，短信验证留到将来）

Supabase Auth 原生支持 `signInWithPassword({ phone, password })`，无需短信通道也可用。改动点：

- **Auth 配置**：通过 `supabase--configure_auth` 或手动确认 Phone Provider 已启用（仅启用 phone 登录，不启用短信发送）。这一步只是开关，不会触发任何短信费用。
- **管理员初始化** `src/routes/api/public/bootstrap-admin.ts`：
  - 现在写死 email `87113911@qq.com`。需要你给一个**管理员手机号**（11 位中国大陆号码即可，例：`13800138000`）。
  - 改为 `supabaseAdmin.auth.admin.createUser({ phone, password, phone_confirm: true })`
  - 翻页查找时也按 `u.phone === phone` 判断；查不到则创建
  - 原来那个 email 用户不动（保留作为兜底），后续如需删除你说一声
- **登录表单** `src/routes/login.tsx`：
  - 字段从「邮箱」改为「手机号」，`type="tel"`、`inputMode="numeric"`、`autoComplete="tel"`、`maxLength={11}`、占位符 `13800138000`
  - 图标从 `Mail` 换成 `Phone`（lucide-react 已有）
  - 提交前用 zod 校验：`/^1[3-9]\d{9}$/`，本地校验失败直接红字提示不发请求
  - 调用 `supabase.auth.signInWithPassword({ phone, password })`

### 1. 精细化错误提示（适配手机号语境）

Supabase 登录失败统一返回 `Invalid login credentials`，前端无法直接区分。后端兜底接口：

- 新增 `src/routes/api/public/auth-precheck.ts`（POST `{ phone }`）：
  - zod 校验手机号格式
  - `supabaseAdmin.auth.admin.listUsers` 翻页匹配 phone，最多 20 页
  - 返回 `{ exists: boolean, systemEmpty: boolean }`（`systemEmpty` 当 auth.users 第一页为空时为 true）
  - 加 `Cache-Control: no-store` 和 `X-Robots-Tag: noindex`
- 登录失败时再调 precheck，根据返回分流：
  - `systemEmpty=true` → 黄色 Alert：「管理员账号尚未初始化」+「立即初始化管理员」按钮（点击 fetch `/api/public/bootstrap-admin`）
  - `exists=false` → 红色 Alert：「该手机号未注册，请确认号码或联系管理员添加账号」
  - `exists=true` → 红色 Alert：「密码错误，请重新输入；忘记密码请联系管理员重置」
  - 网络/5xx → 灰色 Alert：「服务暂时不可用，请稍后重试」+ 重试按钮
- 错误展示从单条红字升级为带图标 + 标题 + 描述 + 行动按钮的 Alert（用现有 `@/components/ui/alert`）

### 2. 密码可见切换（小眼睛）

- 密码框右侧加 `Eye / EyeOff` 图标按钮
- 本地 `showPassword` state 控制 `type="password" | "text"`
- `aria-label="显示密码 / 隐藏密码"`、`tabIndex={-1}`、`type="button"` 避免误触发表单提交
- 输入框 `pr-10` 给按钮让位；`submitting` 时禁用

### 3. 登录后跳转更流畅（修「菜单出来了页面还在登录页」）

根因：`onSubmit` 成功后立即 `navigate('/dashboard')`，而 `useAuthSession`（基于 `onAuthStateChange`）异步更新；`__root.tsx` 用 pathname 判断渲染外壳，存在双重导航 + 中间空白态的撕裂感。

修法（都在 `src/routes/login.tsx`）：
- `onSubmit` 成功分支只做：`setRedirecting(true)` + `toast.success`，**不**直接 navigate
- 让顶部的 `useEffect`（监听 session）统一负责跳转：session 出现 → `router.invalidate()` → `navigate('/dashboard', { replace: true })`
- 进入 `redirecting=true` 后，登录卡片整体盖一层半透明遮罩，中央显示 spinner + 「正在进入后台…」；表单全部禁用
- 顺手修：已登录用户访问 `/login` 直接显示同一过渡遮罩（不再先闪一下登录表单）

### 4. 一致性收尾

- 移除原 toast 错误提示，错误信息只在 inline Alert 里出现一次
- `mem://` 增量更新（建议加入 Core）：登录现采用手机号 + 密码（未来扩展短信验证）；管理员手机号为 ______（待你提供后我替你填）

### 技术细节速览

```text
supabase auth config                启用 phone provider（不启用短信发送）
src/routes/api/public/bootstrap-admin.ts  改 email → phone，phone_confirm: true
src/routes/api/public/auth-precheck.ts    新增，POST { phone } → { exists, systemEmpty }
src/routes/login.tsx                       
  - 字段切换 手机号 + Phone 图标 + 11位校验
  - showPassword 状态 + Eye/EyeOff
  - 错误分类 Alert + 「立即初始化管理员」按钮
  - onSubmit 不再 navigate，redirecting 遮罩
  - useEffect 统一 router.invalidate + navigate
```

### 需要你先确认 2 件事

1. **管理员手机号**：请提供一个 11 位中国大陆手机号（用于初始化管理员账号），密码继续沿用 `pzy5565283` 还是改新的？
2. **旧的邮箱账号** `87113911@qq.com` 是否保留？建议先保留作为兜底，等手机号账号验证通过后再删。

回复后我就开干。
