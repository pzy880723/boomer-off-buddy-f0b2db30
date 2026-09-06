# 只读核验：iOS 拍照上架识别链路（2026-09-06）

本轮**未执行任何写操作**：未改代码/配置、未跑迁移、未写数据库、未碰有赞/库存、未新建商品、未部署腾讯。不输出任何 signed URL、token、密钥或消费者资料。

## 4) 当前最新 commit

`c0fc04df760ae62965451dbeaf35cfd0b4b1a24a`（Sun Sep 6 10:14:00 2026 UTC，"Work in progress"）。

## 1) 模型、环境覆盖、重试/超时、耗时统计

**文件**：`src/server/product-recognition.server.ts`

- 默认模型（第 12 行）：`google/gemini-2.5-pro`。
- 环境覆盖（第 234 行）：`process.env.PRODUCT_RECOGNITION_MODEL || DEFAULT_...`。当前 Lovable 环境中 **`PRODUCT_RECOGNITION_MODEL` = UNSET**（未配置，因此实际走默认 2.5-pro）；`LOVABLE_API_KEY` = SET（值未读取、未输出）。
- 重试（第 146–163 行）：最多 3 次，失败间隔 `200ms × attempt`（200ms / 400ms），三次全败后**不抛错**，而是落一条 `category_code='ai_low_confidence'`、`status='failed'` 的兜底审计记录。
- **超时：没有任何超时/AbortSignal**。第 264 行的 `fetch` 裸调用，无 `AbortController`、无 `signal`、非流式（`response_format: json_object` 一次性返回）。上游卡住时只能等平台请求超时。
- **耗时无法从数据库统计**：`inv_sku_classifications`（31 列）没有任何 duration/latency/started_at 字段，只有 `created_at`。要按次统计耗时目前只能看网关日志。

**网关实测耗时（可核验证据，均为 chat_completions / 200）**：

| log_id | 时间(UTC) | 模型 | 耗时 | tokens in/out |
|---|---|---|---|---|
| 01a0762f-ce1d-7d73-95b1-abae53fbf5c8 | 2026-09-06 10:07:59 | google/gemini-2.5-pro | **39,711 ms** | 12385 / 4216 |
| 01a07603-1c48-753e-b5c4-d613a0d3cca6 | 2026-09-06 09:19:04 | google/gemini-2.5-pro | **33,785 ms** | 12385 / 3026 |

对比同期其它调用：gemini-3-flash-preview 0.9–4.0 s、gemini-2.5-flash 1.5–3.5 s。

近 14 天 `inv_sku_classifications` 共 6 条，全部 `source='handheld'`。

## 2) recognize-item 契约与年代 prompt 约束

**路由**：`src/routes/api/public/handheld/ai.recognize-item.ts` → `POST /api/public/handheld/ai/recognize-item`
先 `authenticateDevice(request)`（需 `X-Device-Token`），再 `AiRecognizeReq.parse`，失败 400 `validation_error`；识别异常统一 502 `AI recognition failed: …`。

**请求体**（`src/lib/handheld/schemas.ts:588–622`，四种图片来源可混用，合并后统一截断到 6 张）：

- `images: [{ image_url? , image_base64? }]`，`min(1).max(6)` — **Codex 计划用的 inline base64 6 角度完全在契约内**，无需改后端。
- `image_urls: string[]` 1–6；`image_storage_paths: [{bucket:'sku-raw'|'sku-listing', storage_path}]` 1–6（服务端自动签名，签名有效期 1h，见 `handheld-ai.server.ts:36`）；以及旧版单图 `image_url` / `image_base64`。
- `primary_index` 0–5：把该下标挪到第 0 位当主图（`handheld-ai.server.ts:71–75`）。
- `hint?: string`。

`image_base64` 允许裸 base64 或 `data:` 前缀，服务端在 `toDataUrl` 里补 `data:image/jpeg;base64,`（第 16–19 行）。**没有大小上限校验**，1280px JPEG 完全可行；6 张原图直传则会明显放大请求体。

**年代/描述相关 prompt 约束**（`product-recognition.server.ts:236–258`）：

- `attributes` 必须含 `era`（与 brand/maker/origin_region/origin_country/material/craft/object_type/colors/dimensions/functional_status/missing_parts 同级）；`attribute_confidence` 需给出 `era` 的逐字段置信度。
- 全局约束："只根据图片可见证据判断，不确定字段返回 null 或空数组"——即年代不确定必须返回 null，禁止猜测。
- 描述限制：品名中文 ≤40 字，描述 ≤160 字。
- 另有强约束：瓷器产地不可确认必须回 `ai_low_confidence`；IP 必须给最具体角色而非母品牌；品牌/标签只能取库内条目，禁止创造。
- **没有**对 era 取值格式（如"昭和/1970s/年代区间"）的枚举约束，这一项目前是自由文本。

## 3) 为什么慢 — 证据与位置

1. **模型选型是主因**：默认 `google/gemini-2.5-pro`（第 12 行，且 `PRODUCT_RECOGNITION_MODEL` 未配置覆盖）。同一网关上 flash 系列 1–4 s，pro 实测 34–40 s，差一个数量级。
2. **系统 prompt 极大**：每次调用都把全量分类树 + 标签库 + 品牌库 + IP 库拼进 system（第 130–140、236–258 行）。当前库存规模：分类 122 条、标签 23 条、品牌/IP 合计 187 条。网关日志显示输入 token 稳定在 **12,385**，其中绝大部分是这段常量 prompt，而不是图片。且它没有任何缓存（每次 `loadCategories/Facets/Brands/Ips` 重新查库再重新拼串）。
3. **输出也长**：3,026–4,216 output tokens（要求返回十几个字段 + evidence + clarification_requests），生成阶段本身就要几十秒。
4. **非流式 + 无超时**：第 264 行一次性 `fetch`，客户端在完整 JSON 返回前拿不到任何反馈；卡住时也没有主动超时，只能等平台层断开。
5. **重试会放大**：失败重试最多 3 次（第 146 行），每次都是一次完整的 30s+ 调用，最坏情况约 100 s 后才落兜底记录。

**可选优化方向（本轮不改）**：配置 `PRODUCT_RECOGNITION_MODEL` 指向 flash 系列即可立刻把主链路从 ~35 s 降到个位数秒；把分类/标签/品牌库 prompt 做进程内缓存 + 裁剪；给 fetch 加显式超时并改流式；把 `inv_sku_classifications` 补一列耗时以便长期统计。

## 安全声明

本轮仅做只读核验：未修改任何代码、配置或数据库；未调用有赞、未改库存、未创建商品、未发布腾讯生产。报告中未包含任何 signed URL、token、密钥值或消费者个人资料。
