
# 给 codex 的 ERP 对接交付方案

按 codex 给的链路（APP → ERP → 有赞）落地。ERP 这边补齐 APP 需要的所有接口，AI 与有赞同步都封在 ERP 内部，APP 不直接触达。

---

## 一、现状与差距

ERP 已有（`/api/public/handheld/*`，详见 `/api-docs`）：
- `auth/ping`、`sku/by-epc`、`sku/search`
- `inbound/scan`（仓库自动入库）
- `stocktake/open|scan|submit`
- `transfer/ship-scan|ship-confirm|receive-scan|receive-confirm`

鉴权：`X-Device-Token`，token 已绑定库位（warehouse / shop）。

差距（codex 要的）：
1. 账号登录（人 + 设备，目前只有设备 token）
2. 当前操作库位切换（一台设备绑多个门店时）
3. 智能上架：拍照 → AI 识别 → 生成上架图 → 人工确认 → 建 SKU → 入库 → 绑 EPC → 同步有赞
4. 图片上传通道（直传到 Lovable Cloud Storage）
5. 标签数据返回（条码/编码/价格）
6. 有赞同步状态查询

---

## 二、新增接口（全部走 `/api/public/handheld/*`，Zod schema 写在 `src/lib/handheld/schemas.ts`，自动进 `/api-docs` 和 SDK）

### 1. 账号 / 库位

- `POST auth/login` — 入参 `{ username, password, device_code }`，返回用户 + 该用户可操作的库位列表 + 新的 `session_token`（短期）。设备 token 继续负责设备身份，session token 叠加人的身份。
- `GET locations` — 当前账号可见的所有 warehouse / shop。
- `POST location/switch` — 入参 `{ location_id }`；之后所有写操作默认落到这个库位。

### 2. 智能上架（核心新链路）

```
POST ai/recognize-item        # 多模态识别 → 结构化字段
POST ai/prepare-listing-image # 出上架主图（裁切/正光/净底，不改商品本体）
POST items/upload-image       # 直传图片到 Storage，返回 URL
POST items/smart-create       # 建 SKU + 落库存 + 绑 EPC + 推有赞队列
GET  items/{id}/sync-status   # 查有赞同步状态
```

`items/smart-create` 入参 / 出参按 codex 给的版本对齐，额外补 `epcs?: string[]`（已打标签就直接绑），`auto_push_youzan: boolean`（默认 false，对齐既有「手动推送」策略）。出参回 `item_code` / `barcode` / `youzan_sync_status`，APP 拿到立即打印标签。

### 3. RFID / EPC 单点操作（补现有缺口）

- `GET rfid/{epc}` — 已有 `sku/by-epc` 的同语义薄包装，方便 APP 路由
- `POST rfid/bind-item` — `{ epc, sku_id, location_id }`，把待认领 EPC 绑到 SKU
- `POST rfid/transfer-location` — 单 EPC 直接改 current_location（仅 admin 设备允许，用于现场纠错）

注：批量入库、调拨、盘点已经存在，不重复造。

---

## 三、AI 选型

封装统一 `aiRecognizeItem` / `aiPrepareListingImage` server fn，模型从 env 配置切换，APP 只看到 ERP 接口。

- 识别（结构化字段）：默认 `google/gemini-2.5-pro`（已是项目里的多模态主力，走 Lovable AI Gateway，不需要单独配置 key）。
- 上架图修整：默认 `google/gemini-3.1-flash-image`（Nano Banana 2，编辑能力强、速度快）；备选 `openai/gpt-image-2`。
- 国内链路（Qwen / Wan）暂不接，留 adapter 接口，后面要切换只改 provider 文件。

输出 schema（识别）：
```
{ name, category, brand, era, condition_grade, description, suggested_price_cny? }
```

修图约束写进 system prompt：只做角度/裁切/底色/光线，禁止改 logo、文字、瑕疵、配件数量。

---

## 四、数据/落库

复用现有表，不新增主表：

- `inv_skus` — 智能上架直接写这里（kind=single 默认）
- `inv_epcs` — `rfid/bind-item` 写入
- `inv_stocks` — `smart-create` 同时 +1
- `sku_youzan_links` + `youzan_stock_sync_queue` — 已有，`auto_push_youzan=true` 时入队

新增轻量表：
- `handheld_sessions(id, user_id, device_id, current_location_id, expires_at)` — 支持人 + 设备 + 当前库位三元组
- `handheld_users(id, username, password_hash, role, allowed_location_ids[])`（也可复用现有 auth.users + user_roles，按当前 user-roles 规范走，**优先复用，不另起一套**）

倾向：**复用 Supabase auth + user_roles**，`auth/login` 内部走 supabase 邮箱/手机号登录，session token = supabase access_token。这样后台用户和手持用户是同一套人。

---

## 五、图片存储

用 Lovable Cloud Storage（Supabase Storage），bucket：
- `sku-raw/` — 店员原图（private）
- `sku-listing/` — AI 生成的上架图（public，给有赞用）

`items/upload-image` 后端签发 signed URL，APP 直传，不走 ERP 中转，避免大图打爆。

---

## 六、标签返回格式

`smart-create` 返回里追加 `label`：
```
{
  item_code: "VG202606280001",
  barcode: "690000000001",
  qrcode_payload: "vg://item/<id>",
  name, price_cny, condition_grade, location_name
}
```

APP 自由选打什么，ERP 不限制模板。

---

## 七、有赞同步规则（明确给 codex）

- ERP 是商品主数据中心
- `smart-create` 默认**不自动推**，APP 给个开关；后台 `/youzan` 也能手动推
- 库存方向：**ERP → 有赞 单向推**（已有 `youzan_stock_sync_queue`）
- 有赞销售回写：暂不做，下一期接 webhook
- 商品分类映射：在 `/youzan` 后台维护映射表（下一期）
- 图片：用 `sku-listing` 的 public URL，有赞侧再缓存

---

## 八、给 codex 的回复包

我会在仓库里产出：
1. `docs/handheld-api.md` 更新到包含全部新接口示例 + 字段说明
2. `/api-docs` 在线 OpenAPI（已有，新接口自动进去）
3. `openapi.snapshot.json` 更新，APP 端跑 `openapi-typescript` 直接生成 TS SDK
4. 一份 `docs/handheld-onboarding.md`：登录流程、token 生命周期、smart-create 端到端时序图、有赞同步状态机
5. 测试设备 token + 测试账号通过私下渠道发，不在仓库

---

## 九、需要 codex / 你确认的 4 件事

1. **登录体系**：直接复用 ERP 现有 Supabase 邮箱密码 + 手持用户角色？还是单独搞一套 username/password？（推荐前者）
2. **AI 模型默认**：识别用 Gemini 2.5 Pro、修图用 Nano Banana 2 — 同意？还是优先国内 Qwen+Wan？
3. **智能上架默认是否自动推有赞**：当前历史决策是「手动推 + 人工绑」，APP 这边要不要保留默认手动？
4. **标签打印**：APP 那边自己渲染 PDF/位图，ERP 只回数据；还是 ERP 也提供一个 `items/{id}/label.png`？

---

## 技术实现位置（给我自己看的）

- 路由：`src/routes/api/public/handheld/{auth.login,locations,location.switch,ai.recognize-item,ai.prepare-listing-image,items.upload-image,items.smart-create,items.$id.sync-status,rfid.$epc,rfid.bind-item,rfid.transfer-location}.ts`
- Schema：追加到 `src/lib/handheld/schemas.ts`
- OpenAPI：在 `src/lib/handheld/openapi.ts` 注册新 path
- AI 封装：`src/lib/handheld-ai.functions.ts`（多模态走 Lovable AI Gateway，schema 走 zod + `Output.object`）
- Storage：新增 migration 建 `sku-raw` / `sku-listing` bucket + RLS
- 鉴权中间件：`src/server/handheld-auth.server.ts` 扩展支持 session token
