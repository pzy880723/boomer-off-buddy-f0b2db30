# 只读核对结果：安卓移植所需四项后台契约（不改代码、不迁移、不部署）

只读核对基线：当前 HEAD c53b83ad（da8c785e 在仓库中存在）。本文只说明代码里的契约，不代表腾讯已经部署。图片处理的提示词、模型和调用路径都没有读，也没有改。

## 1. GET /api/public/handheld/product-taxonomy
文件：src/routes/api/public/handheld/product-taxonomy.ts
- 认证：先验设备，再验员工会话。缺员工会话返回 401 `{code:"session_required"}`。
- 成功返回 `ok({ primary_categories, facets })`：
  - `primary_categories[]`：`{ code, name, children[] }`
  - `children[]`：`{ code, name, parent_code, parent_name }`
  - 只返回 `kind=category` 且 `is_active=true` 的分类。name 为空或与 code 相同的行会被排除。只挂在启用根分类下，不按库存过滤。
  - `facets`：取启用的 inv_facets（id, code, name, dimension, aliases, category_codes, sort_order），经 labelFacets 输出。
- 数据库读失败返回 503 `{code:"taxonomy_unavailable"}`，不会返回假的空列表。
- 测试：src/server/handheld-product-taxonomy-http.test.ts，覆盖 401 时不查库、停用项排除、89 个叶分类全量返回、只读两张字典表、503。

## 2. POST items/smart-create 的可选字段
文件：src/routes/api/public/handheld/items.smart-create.ts、src/lib/handheld/schemas.ts（SmartCreateReq）、src/lib/commerce/product-marks.ts、src/server/product-classification.server.ts
- `featured_stamp`：取值 `new|rare|limited|collectible|discontinued|null`，可省略。省略时与旧版一致，不参与幂等指纹。只在新建商品时同事务保存。
- `notice_tags`：数组，取值 `flawed|function_uncertain|function_unavailable|not_edible|parts_missing`。function_uncertain 与 function_unavailable 互斥。按字典顺序规范化后参与指纹；省略时用旧指纹。
- `ip_candidate`：字符串，trim 后 1–120 字，可省略。
  - 与 `ip_confirmed=true` 或非空 `ip_name` 同时提交时，返回 400 `validation_error`（中文提示）。
  - resolveIpCandidate 用名称、原名或别名精确匹配启用 IP，匹配上就关联该 ip_id。
  - 匹配不上，或 IP 库读取失败：ip_id 为 null，原文存入 SKU 的 `ip_candidate_text`。不创建全局 IP，也不挡上架。
  - 只有请求里带了 ip_candidate，响应才多一个 `ip_review_pending: boolean`。
  - 响应同时回读 `featured_stamp` 和 `notice_tags`。
- 测试：src/lib/handheld/smart-create-ip-candidate.test.ts、src/server/resolve-ip-candidate.test.ts、src/server/handheld-smart-create-fingerprint.test.ts、src/server/handheld-smart-create-cancel-route.test.ts / -cancel-sql.test.ts、src/server/handheld-smart-create-idempotency.test.ts

## 3. 测量待办与个人忽略
文件：src/lib/handheld/work-items.ts、src/server/handheld-work-items.server.ts、src/routes/api/public/handheld/work-items.ts、src/routes/api/public/handheld/work-items.measurement-dismissals.ts、src/server/measurement-dismissals.server.ts

### GET work-items
- 查询参数：`location_id?`（uuid）、`limit`（1–100，默认 50）、`cursor?`、`include_ignored?`、`ignored_only?`。
- 两个布尔参数只接受字面 `"true"`/`"false"`，其余值返回 400 `validation_error`。参数校验是 strict，传未知参数也返回 400。
- 返回 `{ items, counts, next_cursor }`。
  - `next_cursor` 格式为 `"<ts含微秒>|<uuid>"`，要原样回传；格式错误返回 400 `invalid_cursor`。
  - 越权的 location_id 返回 403 `location_forbidden`；服务异常返回 500 `work_items_unavailable`。
- 测量行字段：`measurement_task_id`（任务 UUID）、`measurement_request_version`（含微秒的时间戳字符串，要原样保存）、`can_ignore`、`ignored`、`can_restore`，另有通用字段 id/type/title/description/meta/urgency/action/target_id 等。

### POST（忽略）/ DELETE（撤销）work-items/measurement-dismissals
- 请求体是 strict JSON：`{ location_id: uuid, task_id: uuid, request_version: string(1–120) }`。
- 员工身份只取会话，不读 body 里的 user_id。
- 成功返回 `{ dismissed: boolean, task_id, request_version }`。数据库回执缺字段或变形时返回 500 `dismissal_failed`，不会拿请求参数冒充成功。
- 错误码：

| 状态码 | code | 含义 |
|---|---|---|
| 401 | session_required | 缺员工会话 |
| 400 | validation_error | 请求体不合规 |
| 403 | location_forbidden | 库位越权 |
| 403 | task_location_mismatch | 任务属于其他门店 |
| 404 | task_not_found | 任务不存在 |
| 409 | task_closed | 任务已完成或已取消 |
| 409 | stale_request_version | 版本已变，可能附带 `current_version` |
| 500 | dismissal_failed | 服务异常 |

- 授权规则：带有效客服卡的任务按 support 范围或 general 范围授权；孤立任务只能按 general 范围。
- 测试：src/server/measurement-dismissals.test.ts、src/server/handheld-work-items-http.test.ts、src/lib/handheld/work-items.test.ts、tests/handheld-work-cursor.test.ts

## 4. GET /api/public/handheld/sync-records
文件：src/routes/api/public/handheld/sync-records.ts、src/server/handheld-sync-records.ts、src/lib/sync-record-labels.ts
- 查询参数：`status?`（pending|done|failed）、`limit`（1–200，默认 50）、`location_id?`。
- 库位规则：
  - 有显式 location_id 时必须在授权范围内，否则 403 `location_forbidden`；格式不对返回 400 `validation_error`。
  - 不传时用设备当前库位；设备也没有库位时返回 400 `location_required`。
  - 只有总部账号且当前在总部仓，才能看到全部授权库位。
- 匹配规则：先按 location_id 匹配。只有 location_id 为空的旧记录，才按库位对应的有赞门店 shop_id 补充匹配，避免把他店记录带进来。
- 返回 `{ items[], location_id }`。每条 item 包含：
  - 原始字段：id, sku_id, shop_id, location_id, target_stock, reason, status, attempts, last_error, created_at, updated_at
  - 展示字段：`sku_name`（缺失时为"未命名商品"）、`shop_name`（缺失时为"未关联有赞门店"）、`location_name`（缺失时为"未关联库位"）、`status_label`、`reason_label`、`next_action`、`error_label`（没有错误时为 null）
- 任何读取失败（包括商品名、门店名）都返回 503 `sync_records_unavailable`。
- `status_label` 对 done 显示"同步任务已结束"，不代表有赞库存已经读回。
- 测试：src/server/handheld-sync-records.test.ts、src/server/handheld-sync-records-http.test.ts

## 本次测试证据（只运行，没有改动）
- 用 node --test 跑了 8 个文件，共 28 项：25 项通过，另外 3 个文件在 node 下解析不了 `@/` 路径别名，属于运行环境问题。
- 这 3 个文件改用 bun test 重跑，19/19 通过：smart-create-ip-candidate、handheld-sync-records、measurement-dismissals。
- 本次没有单独重跑以下测试：src/server/handheld-smart-create-idempotency.test.ts、src/server/handheld-smart-create-cancel-route.test.ts、src/server/handheld-smart-create-cancel-sql.test.ts、src/lib/handheld/work-items.test.ts、tests/handheld-work-cursor.test.ts。

## 是否需要新迁移
四项契约都不需要新迁移。
- notice_tags 与 featured_stamp：0095；parts_missing：0104；取消与标签同事务：0110。
- ip_candidate_text 列：0012 / 0045。
- 测量忽略函数与 scoped 待办：0099 / 0100 / 0102。

以上只核对了迁移文件存在，没有查询线上数据库。腾讯生产是否已经部署这些迁移和代码，需要 Codex 读回确认。
