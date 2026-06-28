## 目标

APP 登录账号密码 = ERP 登录账号密码（本来就是同一套 Supabase Auth，`/auth/login` 已经走 `signInWithPassword`）。
真正卡住 Codex 的是 `X-Device-Token` 需要"后台预先开设备"。改成：**用 ERP 账号登录的同时自动签发设备 token，APP 一次性存到本地**，后续调用直接用。

## 改动

### 1. 新接口：`POST /api/public/handheld/auth/bootstrap`

无需 `X-Device-Token`，只要 ERP 邮箱/手机号 + 密码 + APP 自己生成的 `install_id`（UUID，APP 首装时生成、持久化在 keystore）。

请求：
```json
{
  "email": "ops@xxx.com",
  "password": "******",
  "install_id": "uuid-v4-from-app",
  "device_label": "商米 V3 - 仓库1",      // 可选
  "capabilities": { ... },                 // 可选，沿用 v1.2 capabilities schema
  "app_version": "1.0.0",
  "os_version": "Android 13"
}
```

服务端流程：
1. `supabase.auth.signInWithPassword` 校验 ERP 账号；失败直接 401。
2. 在 `inv_handheld_devices` 按 `(owner_user_id, install_id)` upsert：
   - 已存在 → 复用旧记录、刷新 `last_seen_at` / `capabilities`。
   - 不存在 → 新建，自动生成 `device_code = HH-<8位随机>`，`token = nanoid(40)`，`is_active = true`，`default_location_id = null`（首登未绑定库位 → 走"无库位"分支）。
3. 返回：
```json
{
  "ok": true,
  "data": {
    "device_token": "...",          // 之后所有请求带的 X-Device-Token
    "device": { "id":"...", "device_code":"HH-...", "location_id": null, ... },
    "access_token": "...",
    "refresh_token": "...",
    "expires_at": 1700000000,
    "user": { "user_id":"...", "email":"...", "roles":[...] },
    "locations": [ ... ]            // 可见库位列表，APP 自己选择默认库位
  }
}
```

> 老的 `/auth/login`（需要预置 X-Device-Token）保留兼容，不删。

### 2. 库位绑定改成 APP 端自助

- 已有的 `POST /location/switch` 直接复用：APP 登录后让用户从 `locations` 选一个，POST 过去，服务端写回该设备的 `default_location_id`。
- 不再需要后台"激活设备"页面。如果某用户没有任何门店/仓库权限，`locations` 返回空，APP 提示"请联系管理员分配库位"。

### 3. 数据库微调（migration）

`inv_handheld_devices` 增加两列（如不存在）：
- `owner_user_id uuid references auth.users(id)`
- `install_id text`
- 唯一索引 `(owner_user_id, install_id)`，允许 NULL（兼容旧的后台手动建的设备）。

GRANT/RLS 不变，所有写入都走 service_role。

### 4. 文档 + OpenAPI

- `src/lib/handheld/schemas.ts` 新增 `BootstrapReq` / `BootstrapResp`。
- `src/lib/handheld/openapi.ts` 注册新接口。
- `docs/handheld-onboarding.md` 把"第一节"改成：
  > APP 启动：生成并持久化 `install_id` → 用 ERP 账号调 `/auth/bootstrap` → 拿到 `device_token` + `access_token` 全部存 keystore → 之后所有请求带 `X-Device-Token` + `X-Session-Token`。
- `docs/handheld-api.md` 概要同步。

### 5. 给 Codex 的回信文案

简短回复："APP 不要做单独账号体系，直接用 ERP 邮箱密码登录。我加了 `/api/public/handheld/auth/bootstrap`，一次调用同时返回 device_token + access_token，APP 自己生成 install_id 持久化即可。Base URL 不变。AI 接口和 smart-create 的字段已确认（含 era 字段：见下方第 6 点）。"

### 6. 关于 Codex 列的字段问题（顺手在文档里确认即可，不改代码或微调）

- AI `recognize-item` 当前返回字段：`name / category / brand / condition_grade / description / tags / confidence`。**是否需要新增 `era`（年代/风格）字段？** 如要，就在 schema + prompt 加；不要就让 APP 复用 `tags`。
- `smart-create` 当前字段与 Codex 列的清单一致（`name / category / price_tier / is_custom_price / grade / notes / image_url / location_id / auto_push_youzan / client_op_id`），无需改动。
- AI / `smart-create` 接口需要同时带 `X-Device-Token` + `X-Session-Token`（已在 onboarding 文档第 1 节写明）。

## 待你确认

1. **era 字段加不加？**（A：加；B：不加，复用 tags/description）
2. 是否允许"同一 ERP 账号在多台 PDA 上各登一份"？方案默认允许（`install_id` 区分），不允许则改成 `(owner_user_id)` 唯一。
