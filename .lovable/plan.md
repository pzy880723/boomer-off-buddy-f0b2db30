## 现状结论（先回 Codex 的 4 点）

经核对 ERP 代码与线上：

1. **OpenAPI 404 = 没发布**。路由 `src/routes/api/public/handheld/openapi[.]json.ts` 已经存在，**预览站** `…-dev.lovable.app/api/public/handheld/openapi.json` 正常返回 OpenAPI 3.1 JSON；生产站 404 是因为 ERP 自上次改动后**没有点 Publish**。需要你在 Lovable 顶部点一次"Publish / Update"把当前 dev 版本推到 `boomer-off-buddy.lovable.app`。
2. **`image_base64` 是支持的，不止 signed URL**。`AiRecognizeReq` / `AiListingImageReq` 都接受 `image_url` 或 `image_base64`，`recognize-item` 还支持 `images[]`（最多 4 张，每张 url 或 base64 任选）。所以 APP MVP 直接用 base64 是 OK 的，没有"必须先走直传"的限制。文档（`docs/handheld-api.md`）写错了，需要改成"两种都可，base64 适合 MVP，生产推荐 signed URL"。
3. **`/ai/prepare-listing-image` 已经返回 `storage_path` / `signed_url` / `mime_type`**（schema + 路由实现一致，signed URL 7 天有效，桶 `sku-listing` 私有）。无需改动。
4. **`items.smart-create` 已经按你列的清单做了**：生成 `sku_code` + EAN-13 `barcode`、写 `inv_skus`、走 `inv_apply_movement` 入库 + 绑定额外 EPCs、记 `condition_grade`(grade)、按 `auto_push_youzan` 入有赞队列（已绑定才入队，未绑定返回 `youzan_sync_status: "unlinked"`）、返回 `label` 和扁平 `print_payload`。无需改动。

所以**不需要改任何业务代码**，只有两件小事：

## 改动 1：文档 `docs/handheld-api.md` 去掉 base64/URL 不一致

当前那句"图片永远以签名 URL 形式在 APP 和 ERP 之间传递，不在 JSON body 里塞 base64"和实际接口冲突。改成：

- AI 接口（`/ai/recognize-item`、`/ai/prepare-listing-image`）入参支持 `image_url`、`image_base64`、`images[]`（最多 4 张，每张二选一）；
- MVP 可直接传 base64（小于 ~4MB 压缩后图）；
- 生产建议：APP 先调 `/items/upload-image` 拿 signed PUT URL 直传到 `sku-raw` 桶，再把返回的 signed GET URL 当 `image_url` 传给 AI，避免把大图塞 JSON 里。
- `/ai/prepare-listing-image` 永远返回 `storage_path` + 7 天 `signed_url` + `mime_type`，APP 用 `signed_url` 下载/打印。

同时在文档顶部"基本信息"加一句：**生产 base URL 改动后必须重新 Publish，否则 `boomer-off-buddy.lovable.app/api/public/handheld/*` 仍走旧版本**。

## 改动 2：你点一下 Publish

ERP 现在 dev 版（含 v1.2 全部接口）正常，生产站还是旧版没有 openapi.json。等你点完 Publish 我会再 `curl` 一次 `https://boomer-off-buddy.lovable.app/api/public/handheld/openapi.json` 确认 200 + JSON。

## 不动的部分

- `schemas.ts`、`ai.recognize-item.ts`、`ai.prepare-listing-image.ts`、`items.smart-create.ts`、`handheld-ai.server.ts`、`openapi.ts`：全部保持现状，已满足 Codex 列出的所有要求。
- Android APP 当前以 `image_base64` 调 AI 是合法用法，可以继续；后续做大图/多图时再迁到 signed URL，不影响兼容。
