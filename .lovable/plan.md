## 现状有多复杂

每次 Supabase 轮换密钥（或哪怕只是新部署），CVM 上要改 3 个文件：
1. `项目根/.env` —— `bun run build` 把 `VITE_*` 编进前端 JS
2. `dist/server/.dev.vars` —— workerd 运行时读这个，拿 `SUPABASE_SERVICE_ROLE_KEY`
3. `deploy-buddy.sh` —— 里面硬编码了一份当兜底

然后 `bun run build` + `pm2 restart all`。任意一处漏改，登录 401 或"账号管理"白屏。

**根因有两个**：
- A. service_role key 必须放在服务器上（"账号管理"页用它列用户/创建/重置密码/删除）
- B. 同一把 key 在 3 个文件里各存一份，没有单一来源

## 简化方案（两步走，独立可选）

### 第一步：干掉 CVM 上的 service_role key（推荐）

把"账号管理"页的 4 个 admin API 改成**不再用 service_role**，改用 Postgres `SECURITY DEFINER` 函数 + RLS 实现：

| 现在 | 改成 |
|---|---|
| `sb.auth.admin.listUsers()` | DB 函数 `admin_list_users()`，内部读 `auth.users` 字段，函数加超管校验 |
| `sb.auth.admin.createUser({email,password})` | DB 函数 `admin_create_user(phone, password)`，用 `crypt()` 写 `auth.users` |
| `sb.auth.admin.updateUserById(id,{password})` | DB 函数 `admin_reset_password(user_id, password)` |
| `sb.auth.admin.deleteUser(id)` | DB 函数 `admin_delete_user(user_id)` |

每个函数内部第一行先 `if not (auth.jwt()->>'phone' = '18657433310' or ...) then raise exception` 校验超管，然后才执行 admin 操作。

服务端 server function 用**普通 publishable key + 用户 JWT** 调 `supabase.rpc('admin_list_users')`，DB 层校验超管身份。`client.server.ts` 和 `SUPABASE_SERVICE_ROLE_KEY` 整个不再需要。

**收益**：
- CVM `.env` / `.dev.vars` 只剩 publishable key（公开值，可以放仓库、放截图、贴聊天）
- 以后 Supabase 轮换 service_role 跟你完全无关（你压根没在用）
- 即使 publishable key 漏出去也没事（前端 JS 里本来就有）

**代价**：
- 要写一个 SQL migration 加 4 个 `SECURITY DEFINER` 函数
- "创建用户"那个函数稍微绕一点（直接写 `auth.users` 需要 `crypt(password, gen_salt('bf'))`）
- `admin-users.functions.ts` 改 ~30 行

### 第二步：CVM 上密钥单一来源

不管做不做第一步，都把 3 处密钥合并：

```
项目根/.env           ← 唯一手改文件
dist/server/.dev.vars  → 软链到 ../../.env（或部署脚本里 cp 过去）
deploy-buddy.sh       → 不再硬编码 key，从 .env 读
```

`deploy-buddy.sh` 里改成 `set -a; source ./.env; set +a`，然后用 `$VITE_SUPABASE_PUBLISHABLE_KEY` 之类。

**收益**：以后轮换密钥只改 `.env` 一处，跑 `./deploy-buddy.sh` 就完事。

## 推荐组合

**做第一步 + 第二步**：以后 Supabase 这边出什么幺蛾子（key 泄露、误轮换、Lovable 后台抽风）都跟你 CVM 无关。最坏情况你只改 `.env` 里一个公开 key，重新 build 即可，宕机控制在 1 分钟内，也不用再走"申请 service_role → AI 给你一次性密钥"这种紧张流程。

只做第二步：维护负担降一半，但 service_role 还是要管。

## 技术细节（给你 review 用）

1. 直接写 `auth.users` 是 Supabase 官方接受的做法（gotrue 内部就是这么干），关键是 `encrypted_password = crypt(password, gen_salt('bf'))`、`email_confirmed_at = now()`、`instance_id = '00000000-0000-0000-0000-000000000000'`。
2. `SECURITY DEFINER` 函数 owner 必须是 `postgres`（默认就是），并 `revoke execute from public; grant execute to authenticated`。
3. `admin_list_users` 要 `set search_path = public, auth` 才能读 `auth.users`。
4. 超管判定走 `auth.jwt() ->> 'phone'`（你登录用伪邮箱，phone 在 user_metadata 里，所以实际用 `auth.jwt() -> 'user_metadata' ->> 'phone'`）。
5. 改完后 `src/integrations/supabase/client.server.ts` 仍由 Lovable 自动生成，但代码里没人 import 它就行；服务器上 `SUPABASE_SERVICE_ROLE_KEY` 环境变量缺失也不会再报错。

## 给我一句话就开干

- 回 **"两步都做"** → 我写 migration + 改 admin-users.functions.ts + 给你一份新的 `.env` 模板和 `deploy-buddy.sh` 改法
- 回 **"只做第二步"** → 我只给你脚本和 `.env` 模板，代码不动
- 回 **"先讨论"** → 你说哪步有顾虑