## 目标

1. 作废已泄露的 service_role key（`sb_secret_byuOrbJux...`）
2. 让 Lovable 云端 + 你 CVM 服务器拿到一对新的、一致的 publishable / service_role key
3. 服务器重新部署后，登录和"账号管理 / 小包裹数据"都能正常加载

## 步骤

### 1. 在 Lovable 这边轮换 key（我来执行）

调用 `supabase--rotate_api_keys`，它会：
- 生成全新的 `SUPABASE_PUBLISHABLE_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY`
- 自动更新 Lovable Cloud 项目里的 secret
- 自动更新本仓库的 `.env`（VITE_SUPABASE_PUBLISHABLE_KEY）
- 作废所有旧 key（包括泄露那个 + 服务器现在还在用的那个）

⚠️ 轮换瞬间，你服务器上跑的旧 key 立刻全部失效，erp.boomeroff.com 会完全打不开，直到第 3 步完成。

### 2. 把新 key 输出给你（我来执行）

轮换完成后，新的两把 key 会在工具返回里以明文出现一次。我会直接把两把 key 贴在聊天里给你：
- `VITE_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_xxx...`（前端、可公开）
- `SUPABASE_SERVICE_ROLE_KEY` = `sb_secret_xxx...`（**严格保密**）

⚠️ service_role key 你拿到后**只贴到服务器的 `.env` / `.dev.vars` / 部署脚本里**，不要再回贴到聊天 / 截图 / Git。如果不小心又泄露，得再轮换一次。

### 3. 你在 CVM 上更新并重新部署

在 `150.158.94.248` 上，按下面顺序操作：

```bash
# 1) 改项目根 .env
VITE_SUPABASE_PUBLISHABLE_KEY=<新的 publishable>
SUPABASE_PUBLISHABLE_KEY=<新的 publishable>
SUPABASE_SERVICE_ROLE_KEY=<新的 service_role>

# 2) 改 dist/server/.dev.vars（workerd 运行时读这个）
SUPABASE_PUBLISHABLE_KEY=<新的 publishable>
SUPABASE_SERVICE_ROLE_KEY=<新的 service_role>

# 3) 改 deploy-buddy.sh 里硬编码的 key 常量，下次自动用新值

# 4) 重新构建（VITE_* 编译进 JS）
bun run build

# 5) 重启
pm2 restart all
```

## 验证

- 打开 https://erp.boomeroff.com/login，用手机号 + 密码登录，应该不再报"手机号或密码错误"（之前真实原因是 401 Unregistered API key）
- 进 `/purchase/japan-parcel`，小包裹列表能加载
- 进 `/admin/users`（账号管理），用户列表能拉出来（这条特别验证 service_role 是否生效）

## 关键风险 / 注意点

- **窗口期不可避免**：第 1 步到第 3 步之间，服务器是挂的。建议你提前 SSH 连好、改好脚本，我一发新 key 你就贴上去 rebuild，把宕机控制在几分钟内。
- **本仓库 `.env` 的 `SUPABASE_SERVICE_ROLE_KEY` 不会出现在 Git 里**（Lovable 不把它写到 `.env`，只放在 secret 里）。所以你 CVM 那份配置是你自己维护的，必须手动同步。
- 我**不会**自动改 `deploy-buddy.sh`（它在你服务器上，仓库里可能没有），你自己更新。如果它在仓库里，告诉我路径，我下一步可以一起改。

## 准备好就说"开始"

你说"开始"我就执行第 1、2 步。在那之前，先确认你已经能 SSH 上 CVM、准备好改 `.env` 和 `.dev.vars`。