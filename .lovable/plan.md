## 目标

把 codex 这份对接清单完整落到 ERP 侧，让 Android APP 可以从「本地演示模式」一键切到真实 ERP。

## 一、不用问、直接做（已经和 codex 文档对齐或差距很小）

1. **接口扩充**（在现有 11 个基础上补齐）
   - `POST /auth/login` 已有 → 补 `GET /auth/me`、`POST /auth/refresh`（直接转发 Supabase refresh token）
   - `GET /locations` 已有；`POST /location/switch` 已有 → 同时挂一个 `POST /session/location` 别名匹配 codex 文档
   - `POST /items/smart-create` 已有 → 把请求/响应字段名按 codex 文档对齐：
     - 请求加 `price / image_url / source / condition_grade`
     - 响应加 `item_id / item_code / barcode / location_id / stock_qty / youzan_sync_status`
   - 新增 `POST /uploads/item-image`（multipart）：内部转存到 `sku-raw` 桶，返回 7 天 signed URL。原来的「申请 signed PUT URL」接口保留，给大图用
   - 新增 `GET /items/{id}/sync-status`（已有）+ `POST /items/{id}/sync/retry`：把 `youzan_stock_sync_queue` 里 failed 行重置为 pending
   - 新增 `POST /rfid/stock-in`：未知 EPC → 入 `inv_unclaimed_epcs` + 记 location；已知 EPC + 同 location → duplicated；已知 EPC + 异 location → 返回 `needs_transfer_confirm`，由 APP 弹窗后调 `/rfid/transfer-location`
   - `GET /rfid/{rfid_code}`、`POST /rfid/transfer-location` 已有，字段名 `epc` → 同时接受 `rfid_code` 别名

2. **字段与枚举**
   - 新增 `inv_skus.barcode`（EAN-13，自动生成，唯一索引）
   - 新增 `inv_skus.condition_grade` 枚举：`N | S | A | B | C | J`
   - `inv_locations.kind` 已经是 `warehouse | store` → API 输出时映射成 `type` 字段
   - OpenAPI 全局 components 里登记：`LocationType`、`ConditionGrade`、`YouzanSyncStatus`、`RfidCode`、`Barcode`

3. **鉴权升级**
   - login 响应改为 `{ access_token, refresh_token, expires_in, user{id,name,role}, locations[] }`，`role` 取 `user_roles` 里第一条
   - 所有写接口同时接受 `X-Device-Token`（设备级）和 `X-Session-Token`（操作员级，来自 login）；写库时把操作员 user_id 落到 movement 的 `created_by`

4. **文档**
   - 新建 `docs/handheld-onboarding.md`：登录 → 选 location → 拍照 → 上传 → AI 识别/修图 → smart-create → 打印 → 查 sync-status 的完整时序图 + curl 示例
   - 更新 `docs/handheld-api.md` 索引
   - 重新生成 `openapi.snapshot.json`，跑 `sdk:check` 确认无漂移

## 二、需要 codex 一次性回答的所有问题

请把下面这段整段转给 codex，他回完我就直接建：

```
ERP 侧需要 codex 确认以下 8 点。每条都给了我推荐默认值，
如果你都同意，回 "全部按推荐" 即可。

Q1【URL 前缀】
ERP 现有 11 个接口都在 /api/public/handheld/* 下（这个前缀
在 Lovable 发布站点会自动绕过登录页跳转,是平台硬约定)。
你文档里写的是 /api/auth/* /api/locations /api/items/* /api/rfid/*。
  A. APP baseURL 改成 .../api/public/handheld/  ← 推荐
  B. ERP 双挂载,/api/* 和 /api/public/handheld/* 都能访问
  C. ERP 全部迁到 /api/* (需要自己重做鉴权)

Q2【smart-create 默认是否自动推有赞】
ERP 项目现行策略是"手动推送 + 人工绑定有赞商品",避免新建
SPU 在有赞那边重复创建。
  A. 默认手动;APP 想推就传 auto_push_youzan=true;
     SKU 未绑店铺时返回 status=unlinked 让 APP 提示  ← 推荐
  B. 默认自动推到所有已绑店铺
  C. 按 location 配置 (店内自动,仓库手动)

Q3【RFID stock-in 是否允许"裸 EPC"入库】
  A. 允许:未知 EPC 进 inv_unclaimed_epcs+记 location,
     之后由 APP /rfid/bind-item 现场认领 SKU  ← 推荐
  B. 必须带 sku_id,否则 422

Q4【barcode 字段】
APP 文档要 ERP 同时返回 item_code (VG2025...) 和 barcode (690...)。
  A. inv_skus 新增 barcode 字段,EAN-13,ERP 自动生成,全局唯一  ← 推荐
  B. 复用 sku_code,barcode=item_code=sku_code
  C. APP 自己生成 EAN-13 再回传 ERP 存档

Q5【condition_grade 枚举】
你文档里写 N|S|A|B|C|J,ERP 当前没有这个字段。
  A. inv_skus 新增 condition_grade,枚举值就用你给的 N/S/A/B/C/J  ← 推荐
  B. 不存 SKU 上,存到 inv_epcs (每件单独成色)
  C. 两边都存:SKU 默认值 + EPC 可覆盖

Q6【图片存储】
ERP 这边图片放在 Supabase Storage 私有桶 sku-raw / sku-listing,
APP 拿 7 天 signed URL 访问。上传走两种方式:
  - 大图:申请 signed PUT URL,APP 直传桶
  - 小图/兼容旧版:multipart POST /uploads/item-image,
    ERP 中转写桶
两种都做,你这边只用 multipart 即可,不需要关心 OSS / 有赞素材库。
  A. 同意上面方案  ← 推荐
  B. 你希望额外接 OSS / 七牛 (需要用户配 secret)

Q7【刷新 token】
Supabase 原生 refresh_token,有效期默认 30 天滚动。
ERP /auth/refresh 直接转发,access_token 2 小时过期。
  A. OK  ← 推荐
  B. 你希望 ERP 自己签 JWT,不用 Supabase token

Q8【操作员审计】
ERP 写库时希望知道是哪个店员操作的。两种方式:
  A. APP 每个写请求带 X-Device-Token + X-Session-Token (login 后拿到),
     ERP 用 session token 解析 user_id 落到 movement.created_by  ← 推荐
  B. 只用 X-Device-Token,审计粒度到设备
```

## 三、技术细节（给我自己用）

```text
迁移文件 (1 个):
  - inv_skus 增加 barcode text unique, condition_grade text check
  - barcode 生成:'69' + 10 位时间戳尾号 + checksum,DB 函数 gen_ean13()

新增 route 文件:
  src/routes/api/public/handheld/
    auth.me.ts
    auth.refresh.ts
    session.location.ts            (别名 → location.switch)
    uploads.item-image.ts          (multipart → sku-raw)
    items.$id.sync.retry.ts
    rfid.stock-in.ts

schemas.ts 增加:
  - AuthMeRes, RefreshReq, RefreshRes
  - SyncRetryRes
  - RfidStockInReq/Res  (含 needs_transfer_confirm 状态)
  - LocationDTO 加 type: 'store' | 'warehouse'
  - SmartCreateRes 加 item_code/barcode/location_id/stock_qty

openapi.ts 注册全部新路径 + 把 rfid_code/epc 做成 oneOf 别名

docs/handheld-onboarding.md: 完整时序 + curl + 7 个常见错误码
```

## 四、交付物

- 1 份 SQL migration（barcode + condition_grade + EAN13 函数）
- 6 个新 route 文件 + 2 个旧 route 字段补充
- schemas.ts / openapi.ts / openapi.snapshot.json 同步刷新
- `docs/handheld-onboarding.md` + `docs/handheld-api.md` 索引更新
- `bun run sdk:check` 通过

---

**等 codex 回完 Q1-Q8 我就直接开干。** 如果他全部同意推荐项,你回我一句"全部按推荐"即可。
