# Handheld AI 授权契约（policy 2026-10-09-v1）

迁移：`drizzle/migrations/0046_handheld_ai_consent.sql`（已应用到 Lovable Cloud 主库；纯增量）。
回退：`DROP TABLE public.handheld_ai_consents;` 并在 `inv_listing_image_jobs`、`inv_product_content_image_jobs`、`custom_print_cards` 上 `DROP COLUMN ai_actor_user_id, DROP COLUMN ai_policy_version`。回退前需先回退代码。
注意：`deployments/fankuang-basket-20261009/0046_fankuang_basket_gifts.sql` 只是同号候选，不在 drizzle 目录；以后入库时须重新编号。

## 接口
`POST /api/public/handheld/privacy/ai-consent`（X-Device-Token + 员工 Authorization/X-Session-Token）
- body `{"allowed":true|false,"policy_version":"2026-10-09-v1"}`（strict，多余字段如 user_id → 422）
- 200 `{"ok":true,"data":{"allowed":true,"policy_version":"2026-10-09-v1"}}`（data 为数据库回读值）
- 401 无设备/无员工 session；409 `policy_version_mismatch`；422 `validation_error`；503 `consent_unavailable`（保存失败，绝不伪成功）
`GET` 同路径返回当前账号 + 当前版本的状态；没有记录时为 `allowed:false`。

## AI 入口（AI 出站前检查；未授权返回 403 `ai_consent_required`）
ai/recognize-item、ai/recognize-title、ai/prepare-listing-image、ai/generate-summary、content/generate-from-sku、
items/{id}/content（只限 action=generate）、items/{id}/recommendation-card、print/custom-cards 新建以及 regenerate、
parcels/items/{id}/pack-pieces/estimate-title|estimate-image。
recognize-item/title/prepare-listing-image/generate-from-sku 以前只校验设备，现在还要求员工 session。

## 排队
- smart-create：`ai_processing_allowed=false` 时不排队；true 或缺省时仍以数据库授权为准。该字段不参与幂等指纹。响应新增 `data.ai_processing`：allowed | skipped_by_client | consent_required | consent_unavailable。
- 上架修图、详情图、自定义卡片任务都记录 ai_actor_user_id + ai_policy_version，worker 每次调用 AI 前重查；没有记录、版本不对或已撤回时不调 AI，任务按可重试失败处理，原图保留。
- 撤回不能收回已经发出的 AI 请求。

## 老客户端升级
没有授权记录就视为拒绝。老 App 不会调用授权接口，发布后 AI 入口会返回 403 + 中文提示，手动上架、浏览、收银、打印不受影响。建议先上架 1.1.39 原生授权页，再发布后端，或二者同时发布；不要加"默认同意"的开关。

## 2026-10-09 验收修复（outbound guard / 详情图事务绑定 / 回退语法）

- 每一次真实 AI 出站（以及 Firecrawl 年代研究）前都执行 `beforeAiOutbound` / `beforeHandheldAiOutbound`，guard 为必填参数，无默认放行：
  - 上架修图：加载原图前、classify 前、generate 前、validate 前各查一次（`handheld-ai.server.ts`、`listing-image-safety.server.ts`）。
  - 识别：每次模型尝试前（含重试），在 try 外抛出，不会降级成兜底结果（`product-recognition.server.ts`）。
  - 标题、简介、商品卡（含审核失败重写）、详情生成故事与年代研究、自定义卡片（参考图加载之后、网关请求前）。
  - 队列 worker 用任务原 actor + policy 构造 guard；中途撤回 → `ai_consent_missing`，读不到 → `ai_consent_unavailable`，原图保留。
  - PC ERP `recognizeProductFromImages` 显式传 `webErpAiGuard()`；手持专用模块拒绝 web guard。
  - 请求中途撤回时接口返回与入口一致的 403 `ai_consent_required` / 503 `consent_unavailable`。
- 详情图任务：迁移 `0047_content_image_job_actor.sql`（已应用）新增 `handheld_product_content(..., p_ai_policy_version text)` 重载，在同一事务的 INSERT/重新排队语句里写入 actor + policy；删除原事务后批量 stamp。旧 5 参函数保留不变（旧调用产生的无 actor 任务永远不送 AI）。
- 0046 回退注释改为每表一条语句，`tests/sql/content_image_actor/run.sh` 实际执行两份回退语句验证。
