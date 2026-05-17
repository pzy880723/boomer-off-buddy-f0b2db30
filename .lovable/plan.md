## 目标
把腾讯云服务器 `~/boomer-off-buddy-source/.env` 里的 Supabase 三件套切换成新版 `sb_` 格式，并补齐业务密钥，让 wrangler/PM2 跑起来后能正常访问后端。

## 服务器上要执行的命令

```bash
# 1. 备份当前 .env
ssh -i ~/.ssh/tencent_boomer ubuntu@150.158.94.248 \
  "cp ~/boomer-off-buddy-source/.env ~/boomer-off-buddy-source/.env.bak.$(date +%s)"

# 2. 覆盖写入新的 .env
ssh -i ~/.ssh/tencent_boomer ubuntu@150.158.94.248 \
  "cat > ~/boomer-off-buddy-source/.env <<'EOF'
SUPABASE_URL=\"https://sxddfcoiaboqcmeviykl.supabase.co\"
SUPABASE_PUBLISHABLE_KEY=\"sb_publishable_8Spsd4RjtpxpmZ0kmYHFgQ_kBSRWz56\"
SUPABASE_SERVICE_ROLE_KEY=\"sb_secret_byuOrbJuxkdwCeoCeDz6tA_MsGnLGGp\"
VITE_SUPABASE_URL=\"https://sxddfcoiaboqcmeviykl.supabase.co\"
VITE_SUPABASE_PUBLISHABLE_KEY=\"sb_publishable_8Spsd4RjtpxpmZ0kmYHFgQ_kBSRWz56\"
VITE_SUPABASE_PROJECT_ID=\"sxddfcoiaboqcmeviykl\"
MERUKI_ENC_KEY=\"pzy5565283\"
LOVABLE_API_KEY=\"<把之前导出的 sk_... 完整值粘进来>\"
EOF"

# 3. 因为 VITE_* 变了，要重新构建前端
ssh -i ~/.ssh/tencent_boomer ubuntu@150.158.94.248 \
  "cd ~/boomer-off-buddy-source && npm run build"

# 4. 重启 PM2（wrangler 进程会重新读 .env）
ssh -i ~/.ssh/tencent_boomer ubuntu@150.158.94.248 \
  "pm2 restart all && pm2 logs --lines 30 --nostream"
```

## 验证

```bash
# 本机访问后端首页
ssh -i ~/.ssh/tencent_boomer ubuntu@150.158.94.248 \
  "curl -sI http://127.0.0.1:3001 | head -5"

# 通过域名访问
curl -sI https://erp.boomeroff.com | head -5
```

打开 https://erp.boomeroff.com/purchase/japan-parcel ：
- 列表能加载 → `SUPABASE_SERVICE_ROLE_KEY` 生效
- 智能识别能跑 → `LOVABLE_API_KEY` 生效
- meruki 账号加密字段能解 → `MERUKI_ENC_KEY` 生效

## 注意

- 旧 JWT 格式 (`eyJ...`) 的 anon/service_role key 不要再用，统一走 `sb_` 新格式。
- 这次只改 `.env` + rebuild + restart，不动任何源码、不动 nginx、不动 PM2 配置。
- 如果重启后 502，先 `pm2 logs` 看 wrangler 输出，最常见原因是 `LOVABLE_API_KEY` 粘贴时少了字符。
