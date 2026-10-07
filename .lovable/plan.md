# 只读契约审查：手机端单图自然语言微调

本轮只读，没有改代码、数据库或 Secret，也没有生成或发布。审查时的最新提交：`2e2fda6bcd8487d56a820cb56033e0f034001f23`。

## 已有可复用能力（已核实）

1. 手持端 AI 修图接口 `POST /api/public/handheld/ai/prepare-listing-image`（文件 `src/routes/api/public/handheld/ai.prepare-listing-image.ts`）
   - 鉴权：`authenticateDevice` 设备令牌。没有 SKU、门店或商品归属校验。
   - 请求 `AiListingImageReq`：`image_url?`、`image_base64?`、`instruction?`（已有一句自然语言字段）。
   - 响应：`{storage_path, signed_url(7天), mime_type}`。只上传到 `sku-listing/{日期}/{device}/{uuid}`，**不替换任何商品图**，可以当作“候选图”使用。
2. 核心函数 `aiPrepareListingImage`（`src/server/handheld-ai.server.ts`）
   - 固定系统提示：1:1 正方形 1024、主体居中裁切、统一浅灰底、校正角度和白平衡、清除价签；`instruction` 只是追加在后面的“额外要求”。
   - 先用 `measurementProtectionRequired` 检测是否有尺子。检测到尺子时直接返回原图补边成正方形（`squareOriginalImage`），**用户的 instruction 会被静默忽略**。检测失败或置信度低时报错。
   - 模型：`google/gemini-3.1-flash-image`（chat/completions，60 秒超时）。
3. 单图原子替换函数 `public.handheld_apply_listing_image_result(p_sku_id, p_source_key, p_target_key) → boolean`（数据库实际定义）
   - SECURITY DEFINER，执行时 `FOR UPDATE` 锁住 SKU。按“原图 key 值”替换：原 key 已不在 `image_paths` 里就返回 false，可视为比较后替换（CAS）。
   - 替换时保持原有顺序，只换这一项；同时替换 `commerce_listings.image_paths` 里状态为 draft/published/reserved/hidden 的同一 key。不碰条码、库存、价格和上下架。
   - 风险：替换后会去重，如果目标 key 已经存在会合并成一项；`image_url` 会按第一张图重算。
   - 本次查询没有读到 EXECUTE 授权信息，权限情况未核实，实施前需要确认仅 service_role 可执行。
4. 批量任务队列 `inv_listing_image_jobs` 与 `handheld_listing_image_claim/finish`（`src/server/handheld-listing-image-jobs.server.ts`）
   - 带 claim_token 和租约，成功才替换。只处理 sku-raw 原图，唯一键 `(sku_id, source_bucket, source_path)`，目标路径前缀固定为 gallery/。不接受 instruction，也没有“候选待确认”状态。
5. 有赞同步：`src/lib/commerce/listing-image-sync.ts`（只替换相等的 key），另有 `youzan-image-refresh` worker（迁移 `20260927190000_youzan_image_refresh.sql`）。本轮没有逐行核实单图替换后会不会自动触发重新推送。

## 原图与版本保留

- 原图对象：存储都用 `upsert:false`，旧对象不删除，所以被替换下来的图在存储里仍然存在。
- 版本记录：没有按图片位置保存的版本历史表或字段。替换后，“上一版”只留在旧任务行或脚本日志里，无法按位置撤回。

## 1:1 默认处理是否适合局部微调

不适合直接复用默认处理：
- 它会整图重新生成：强制裁成正方形、换背景、校正角度和白平衡、去价签，等于整张图重画，不是局部微调。
- 检测到尺子时会忽略用户指令，直接返回补边原图。这对“保留刻度”是安全的，但前端会把它当作已经生成了候选，形成伪成功。
- 没有对 Logo、颜色、瑕疵做像素级或差异校验，只靠提示词约束。

## 实现缺口

1. 微调专用模式：不强制 1:1、不换背景、只做 instruction 描述的修改。尺子图要么拒绝，要么明确返回“受保护未修改”，不能伪装成生成成功。
2. 归属校验：候选生成和确认替换都要校验设备所在门店拥有该 SKU、SKU 处于 active、商品已上架，并校验原 key 确实在当前图片列表里。
3. 确认接口：一个“确认替换”接口，带 `sku_id`、`source_key`、`candidate_key`、`expected_index` 或 `image_paths` 的版本号，调用单图原子替换。需要防止目标 key 已存在导致合并，并处理第一张图变化后重算 `image_url`。
4. 版本保留：新增按位置记录的版本日志（至少记录 sku、位置、旧 key、新 key、操作人、instruction、时间），并提供撤回接口。这一项需要迁移，与“不加云端表”的偏好冲突，需要你来决定。
5. 候选清理：没有确认的候选图要定期清理，或者设置有效期。
6. 同步确认：替换后有赞和官方商城是否自动重新推送，需要核实或补一条明确触发。
7. 测试：并发双确认、原图已被删除、跨门店、尺子图、目标重复，以及条码、库存和其他图片不变。

## 关于商品卡库

第一版沿用原生本机/账号/门店持久化，不需要新的云端表，这与当前 PC 卡片打印用静态清单的做法一致，没有冲突。

## 待你决定

- 版本历史是否允许新增一张窄表（推荐），还是只依赖存储里的旧对象，不支持撤回。
- 尺子图：直接禁止微调，还是允许但只改背景以外的内容。

实施需要你另行明确授权。批准本方案只代表确认这份审查结论，不会开始开发。
