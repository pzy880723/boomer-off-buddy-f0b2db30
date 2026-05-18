## 现状

1. `src/components/app-sidebar.tsx` 里没有"账号管理"入口，只能手动输 `/admin/users` 进入 —— 这就是"找不到 / 好像不能用"的最直观原因。
2. `/admin/users` 页面本身（`src/routes/admin.users.tsx` + `src/lib/admin-users.functions.ts`）逻辑是完整的：
   - 客户端用 `resolveUserPhone(session.user)` 判断超级管理员；
   - 服务端 `listUsersFn / createUserFn / resetUserPasswordFn / deleteUserFn` 都走 `requireSupabaseAuth` + `assertSuperAdmin` + Service Role key；
   - 所需的 `SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_URL` Secrets 已存在。
   - 目前没有任何日志报错。

所以这次只需要：补上侧边栏入口，再在浏览器里跑一遍 CRUD 验证。

## 方案

### 1. 侧边栏底部加"账号管理"分组

改 `src/components/app-sidebar.tsx`：

- `NavTo` 联合类型新增 `"/admin/users"`。
- `groups` 数组末尾追加一组（放在"运营"组之后，成为最后一组）：
  ```ts
  {
    label: "系统",
    items: [{ title: "账号管理", url: "/admin/users", icon: ShieldCheck }],
  }
  ```
  图标从 `lucide-react` 引入 `ShieldCheck`（已有用户管理语义），保持和页面里 Badge 一致。
- 因为这一项只对超级管理员有意义，菜单项渲染时用 `useAuthSession()` + `isSuperAdminPhone(resolveUserPhone(session?.user))` 判断；非超管自动隐藏，避免误点后看到"无权访问"。
- 普通组依旧按 `groups` 渲染，新组单独条件渲染，逻辑写在 `AppSidebar` 内部，不破坏现有循环。

### 2. 验证 /admin/users 功能

侧边栏改完后，让用户从菜单点进去，依次试：

1. 进页面 → 列表能加载出当前账号（至少有 `18657433310`）。
2. 「新增账号」→ 随便填一个 11 位手机号 + ≥6 位密码 → toast 成功 + 列表多一行 + 该行"状态"列显示"待修改密码"。
3. 在新账号那行点「重置密码」→ 输入新密码 → toast 成功。
4. 点新账号那行「删除」→ 确认 → toast 成功 + 该行消失。
5. 用新账号在 `/login` 登一次，确认密码生效 + 触发首登改密弹窗（`change-password-dialog`）。

我会在改完代码后用 server-function-logs / network 抓一遍，如果有 500 / 401 / RLS / Service Role 相关报错直接定位修复；目前预期是一切正常。

## 仅改这一个文件

- `src/components/app-sidebar.tsx`

`admin.users.tsx` 和 `admin-users.functions.ts` 暂不动，等验证发现具体 bug 再说。
