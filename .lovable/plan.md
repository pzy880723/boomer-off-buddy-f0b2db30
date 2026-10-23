# 拍照上架确认页：提交锁 / 价格 / 特色与提示标签 / 简介 — 只读审计与最小修复方案

本轮只读：代码、数据库、Tencent 都没改，也没有生成商品。积分任务已暂停：迁移 0109 已应用，路由和驱动还没接，所有开关仍是关闭状态。

## 一、只读核对结果

### 1. 上架幂等（handheld_smart_create_ops）
- 字段：id, device_id, client_op_id, user_id, location_id, payload_fingerprint, sku_id, bound_epcs, stock_qty, status(committed/completed), response_json, created_at, completed_at。
- 路由 `src/routes/api/public/handheld/items.smart-create.ts`：
  - 先查 (device_id, client_op_id) 是否已有记录。
    - user、location 或指纹任一不同：返回 409 `client_op_id_conflict`，**不写入任何东西**。
    - 已有 response_json：按原结果回放（200）。
  - 建品只在 `handheld_smart_create_commit_v2` 这一个事务里完成，之后由 `handheld_smart_create_complete` 写回结果。
  - 提交前的失败（400 `validation_error`、401、403、404、422 品类/标签/品牌/IP 确认、503 幂等查询失败）**都发生在建品事务之前，不会留下记录，也没有库存**。
  - 事务之后的 500（保存属性/品牌/标签/IP 失败，或"无法确认条码"的 503）发生时**商品已经建好**，必须用同一个 op 重试。
- 线上最近 60 分钟：ops 表 2 条，均为 completed，没有卡在 committed 的记录。最近 24 小时 5 条，也全部 completed。
- 提交前被拒的请求不落库。主进程日志在腾讯 PM2 上，本环境读不到，所以**最近失败的错误码分布无法从持久记录取得**。

### 2. 特色 / 提示标签
- `SmartCreateReq`（`src/lib/handheld/schemas.ts`）**没有** featured_stamp / notice_tags 字段，而且不是 strict 模式，未知字段会被静默丢弃，不会报 400。
- `handheld_smart_create_commit_v2` 函数正文里没有出现 featured_stamp 或 notice_tags。
- 编辑接口（`item-edit-schemas.ts`、`handheld-item-edit.server.ts`）已经支持：featured_stamp 单选（null 清空），notice_tags 多选（含 parts_missing、互斥校验，经 normalizeNoticeTags 处理）。
- 结论：确认页传的标签目前**不会保存**，而且服务端不会提示。

### 3. 简介（`src/server/listing-summary.server.ts`）
- 模型 `openai/gpt-6-astra`，走 /v1/responses，reasoning low，输出 json_object，超时 20 秒。
- 返回内容为空、不是 JSON、超过 80 字、或含年份/绝版等禁用词时，一律抛错，路由返回 503。**不会出现"成功但简介为空"**。
- 提示词要求 20~40 字，解析允许最多 80 字，两者口径不一致。
- 网关记录（本项目，06:00 至 07:07）：gpt-6-astra 8 次，全部 200，耗时 3.6~5.9 秒。另有 3 次 gemini 调用在 11~19 秒时被取消（499），属于识别链路，不是简介。
- 网关只保留截断的内容，所以"偶发空"的具体原因**未确认**。最可能的两种情况：输出被禁用词或超长规则拒绝（返回 503）；或者手机端把 503 显示成了空。

## 二、根因判断（价格无法填写）
- iOS 端只要 `draft.submission != nil` 就会禁用整张表单，只有收到 400/422 才清锁。
- 但 401、403、404 和 409 `client_op_id_conflict` 同样是**确定没有提交**的拒绝；503（幂等查询失败）也发生在建品之前。这几种情况目前都保留了锁，店员就填不了价格。
- 另外，目前没有一个只读接口能查原 client_op_id 的状态，结果未知时只能用原 op 盲重试。

## 三、最小修复方案（待批准后实施）
1. **新增只读状态查询** `GET /api/public/handheld/items/smart-create/ops/{client_op_id}`：用设备和会话认证，只查本设备、本人、本库位的记录。
   - 返回 `none` / `committed`（商品已建，需用原 op 重试补完）/ `completed`（附原响应）。
   - 不返回其他人的数据，不建品，不改锁。
2. **明确的"未提交"标记**：所有在建品事务之前返回的错误都附带 `submitted:false`，事务之后的错误附带 `submitted:true`。这样 APP 只看这个标记决定清锁，不再靠猜状态码。
3. **标签随上架保存**：SmartCreateReq 增加可选的 `featured_stamp`、`notice_tags`，校验规则复用编辑接口（单选 / 多选、互斥、parts_missing）。这两个字段计入幂等指纹，并在 commit_v2 同一事务中写入（迁移只给 v2 增加参数，不改其他逻辑）。省略时保持现状。
4. **简介**：把 80 字上限与提示词对齐为 20~40 字（允许最多 60 字），失败时返回明确错误码（`ai_unsupported_claim` / `ai_invalid_output` / `ai_timeout`），不返回空字符串。不改模型、不改调用路径。
5. 测试：幂等回放和 409 不建品；状态查询的隔离；标签原子保存和指纹；简介各类失败码。

## 四、给 Codex（原生端）
- 清锁规则：`submitted:false` 时清锁并允许编辑；`submitted:true`，或响应丢失、5xx 不带标记时，保留原 op，先调状态查询：`none` 才允许解锁，`committed` 时用原 op 重试，`completed` 时直接展示结果。
- 确认页的标签区复用编辑页的控件，按新字段提交。

## 五、边界
抠图和修图相关的代码、模型、依赖、提示词、调用路径全部不动；不发布 Tencent；不生成真实商品。
