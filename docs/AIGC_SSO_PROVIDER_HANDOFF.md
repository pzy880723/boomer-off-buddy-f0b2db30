# AIGC SSO Provider Handoff（BOOMER ERP → AIGC）

本文档给 BOOMER.OFF AIGC 项目接入 ERP 单点登录时使用。ERP 侧是**身份提供方（IdP）**，AIGC 侧是**依赖方（RP）**。

---

## 1. ERP 生产 Base URL

- Published（正式）：`https://boomer-off-buddy.lovable.app`
- Preview（预发）：`https://id-preview--2158bffa-7f82-4bc6-9df9-c59319d262f7.lovable.app`

自定义域名：目前未绑定，接入前如需切换请提前告知。

---

## 2. 两个接口

### 2.1 生成一次性 Ticket

`POST {ERP_BASE_URL}/api/public/sso/aigc-ticket`

- **调用方**：ERP 前端（用户浏览器）
- **鉴权**：HTTP Header `Authorization: Bearer <ERP Supabase access_token>`
  - ERP 前端从当前 Supabase session 取出 `access_token` 传入；access_token 不出现在 URL 中。
- **请求体**：无

**成功响应 `200`：**

```json
{
  "ok": true,
  "data": {
    "ticket": "K3xQ...long-random-url-safe-string...",
    "expires_at": "2026-07-19T08:01:00.000Z",
    "expires_in": 60,
    "redirect_url": "https://aigc.boomeroff.com/auth/erp?ticket=K3xQ..."
  }
}
```

**失败响应示例：**

```json
{ "ok": false, "error": "登录已失效，请重新登录", "code": "invalid_session" }
```

- `ticket` 是明文票据，只在浏览器与 AIGC 之间传输一次；服务端只持久化 `SHA-256(ticket)`。
- TTL 60 秒，且**只能兑换一次**。

### 2.2 服务端兑换 Ticket

`POST {ERP_BASE_URL}/api/public/sso/aigc-exchange`

- **调用方**：AIGC 后端（严禁在浏览器直接调用）
- **鉴权**（二选一，服务端保存的共享密钥）：
  - `X-ERP-SSO-Secret: <ERP_AIGC_SSO_SECRET>`
  - 或 `Authorization: Bearer <ERP_AIGC_SSO_SECRET>`

**请求体：**

```json
{ "ticket": "K3xQ...上一步拿到的 ticket..." }
```

**成功响应 `200`：**

```json
{
  "ok": true,
  "data": {
    "user": {
      "id": "uuid-of-auth-user",
      "phone": "18657433310",
      "display_name": "张三",
      "roles": ["store_manager"],
      "permissions": ["aigc_access"],
      "shops": [{ "id": "loc-uuid", "name": "中信泰富店" }]
    }
  }
}
```

- **不会**返回 ERP 的 access_token / refresh_token / 邮箱 / 密码，AIGC 侧应基于返回的 `id`（ERP user_id）建立自己的会话。
- `roles` 来自 ERP 的 `public.user_roles` 表。允许进入 AIGC 的角色为 `super_admin`、`hq_operator`、`store_manager`、`store_staff`；只有 `warehouse_staff` 的账号不放行。
- `permissions` 当前对已放行用户返回 `aigc_access`，AIGC 仍会同时复核角色，不能只信任单一字段。
- 总部角色返回全部启用门店；门店角色仅返回 `public.user_location_perms` 中 `kind='shop'` 的门店。

---

## 3. 错误码

| HTTP | code                    | 含义                               | 出现在            |
| ---- | ----------------------- | ---------------------------------- | ----------------- |
| 401  | `unauthorized`          | 没带 Bearer / 密钥错误             | ticket & exchange |
| 401  | `invalid_session`       | ERP session 已失效                 | ticket            |
| 403  | `user_banned`           | 用户已停用                         | ticket & exchange |
| 403  | `no_aigc_permission`    | 账号角色不允许进入 AIGC            | ticket & exchange |
| 500  | `ticket_persist_failed` | 数据库写入失败                     | ticket            |
| 400  | `invalid_body`          | 请求体 JSON 解析失败               | exchange          |
| 400  | `ticket_required`       | 请求体缺少 `ticket`                | exchange          |
| 400  | `ticket_invalid`        | 票据不存在                         | exchange          |
| 400  | `ticket_consumed`       | 票据已被使用                       | exchange          |
| 400  | `ticket_expired`        | 票据已过期（>60s）                 | exchange          |
| 500  | `secret_missing`        | 服务端未配置 `ERP_AIGC_SSO_SECRET` | exchange          |
| 500  | `consume_failed`        | 原子消费失败                       | exchange          |
| 500  | `role_lookup_failed`    | ERP 角色读取失败                   | ticket & exchange |
| 500  | `shop_lookup_failed`    | ERP 门店范围读取失败               | exchange          |
| 404  | `user_not_found`        | 用户已被删除                       | exchange          |

---

## 4. 环境变量 / 密钥

| 名称                  | 存放位置                               | 用途                                                                                                                                       |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ERP_AIGC_SSO_SECRET` | ERP Lovable Secrets（已生成，64 字符） | ERP exchange 接口的共享密钥；请 ERP 管理员通过安全渠道同步一份到 AIGC 项目的 Secrets，值只能人工线下传递，绝不出现在聊天、日志、前端代码里 |
| `AIGC_PUBLIC_URL`     | ERP Lovable Secrets                    | AIGC 对外地址，生产值为 `https://aigc.boomeroff.com`                                                                                       |

轮换建议：AIGC 侧下线时 / 密钥怀疑泄露时立即轮换，双方同时更新。

---

## 5. Migration 文件路径

数据表 `public.aigc_sso_tickets`

- Migration：本次通过 Lovable Cloud 数据库迁移工具直接执行，无独立文件路径；等效 SQL 见下：

```sql
CREATE TABLE public.aigc_sso_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.aigc_sso_tickets TO service_role;
ALTER TABLE public.aigc_sso_tickets ENABLE ROW LEVEL SECURITY;
-- 无 anon / authenticated 策略：浏览器和普通登录用户完全无法访问，仅 service_role 可以操作。
```

辅助函数 `public.aigc_sso_cleanup_expired()`：删除 7 天以前的记录，可用 pg_cron 每天调度一次。权限收紧迁移位于 `supabase/migrations/20260719110000_harden_aigc_sso_permissions.sql`，必须在 ERP Supabase 执行。

---

## 6. ERP 用户 / 角色 / 门店字段说明

- **用户**（`auth.users` + `user_metadata`）
  - `id`：uuid，ERP 唯一主键，也是 AIGC 侧关联的稳定 ID
  - `phone`：ERP 登录手机号（部分历史用户存在 `user_metadata.phone`）
  - `display_name`：来自 `user_metadata.display_name` / `name` / `full_name` 之一，可能为 `null`
- **角色**（`public.user_roles`）
  - 多行：一个用户可以有多个角色
  - 字段 `role` 是枚举 `app_role`（`super_admin` / `hq_operator` / `store_manager` / `store_staff` / `warehouse_staff`）
  - ERP 和 AIGC 两侧都会执行相同的 AIGC 访问校验，避免单侧配置错误绕过权限
- **门店**（`public.user_location_perms` → `public.inv_locations`）
  - 仅返回 `kind='shop'` 的库位；`kind='warehouse'`（仓库）不返回
  - 字段 `id`（uuid）、`name`（门店名，例：中信泰富店）

---

## 7. AIGC 接入步骤

1. **配置密钥**：从 ERP 管理员处线下拿到 `ERP_AIGC_SSO_SECRET`，写入 AIGC 项目 Secrets，命名保持一致。
2. **准备 ERP Base URL**：目前使用 `https://boomer-off-buddy.lovable.app`。域名切换时再通知 AIGC 更新。
3. **AIGC 前端接收 ticket**：在路由 `/auth/erp` 读取 URL 查询参数 `ticket`。收到后**立即**转到自己的后端接口，然后清除 URL 中的 `ticket`（`history.replaceState`），避免留在浏览器历史里。
4. **AIGC 后端 exchange**：`POST https://boomer-off-buddy.lovable.app/api/public/sso/aigc-exchange`，带 `X-ERP-SSO-Secret` 头、body `{ "ticket": "..." }`。
5. **建立本地会话**：以返回的 `user.id` 为主键 upsert AIGC 的 users 表；把 `roles`、`shops` 存进 session 或每次登录时刷新。
6. **登录成功后跳转**到 AIGC 的目标页面。若 exchange 失败按错误码给用户提示并回到 AIGC 登录页（不要跳回 ERP，ERP 会话仍然有效）。
7. **不要**把 ticket、ERP_AIGC_SSO_SECRET 写进任何前端代码、日志、URL query、监控。

---

## 8. 当前部署状态

| 项目                                 | 状态                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| 数据表 `public.aigc_sso_tickets`     | ✅ 已在生产 Supabase 创建，服务端可用                                                       |
| `POST /api/public/sso/aigc-ticket`   | ✅ 代码已合入 Git；需要 Lovable Publish 后才会更新生产环境                                  |
| `POST /api/public/sso/aigc-exchange` | ✅ 代码已合入 Git；需要 Lovable Publish 后才会更新生产环境                                  |
| 侧栏「AI 营销中心」入口              | ✅ 已加到 `SidebarFooter` 上方，跳转目标域 `https://aigc.boomeroff.com/auth/erp?ticket=...` |
| `ERP_AIGC_SSO_SECRET`                | ✅ 已在 ERP Lovable Secrets 中生成（64 字符），未同步到 AIGC——接入前请管理员线下同步        |
| 域名 `https://aigc.boomeroff.com`    | ⏳ **未在 Lovable / DNS 中绑定**，ERP 只是按约定拼这个 URL，实际生效需要 AIGC 团队完成绑定  |
| ERP 用户身份 / 角色 / 门店           | ✅ 代码契约完成；真实账号端到端验收仍需双方发布、迁移和同一份 Secret                        |

> 发布 ERP 后请回归验证：登录 ERP → 点击「AI 营销中心」→ 新标签页应带上 `?ticket=...`；AIGC 若尚未上线可在该新标签页手动模拟 exchange 调用做联调。
