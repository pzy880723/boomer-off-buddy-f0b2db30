# 微调预览：现有API外层顺序重试（2026-10-27更新）

## 当前方案（替代下方未实施的持久任务草案）
- 不新增preview任务API/worker。现有POST `/api/public/handheld/ai/prepare-listing-image` 单次预算、请求及成功响应保持不变。
- 仅明确结束的生成/分类/质量暂时失败返回HTTP502：`{ok:false,error:"本次修图未完成，请稍后重试，原图已保留",code:"retouch_retryable",retry_after_seconds:30或900}`。沿用现有err格式，code在顶层，不是error.code。
- 原生最多3次顺序请求，每次独立现有90/120s；普通失败等待max(服务端delay,30/60s)，429等待至少900s。保持existingbusy文本和预览确认，不自动替换。
- 超时/断网/非JSON错误结果不确定不自动复制调用；auth/consent/refusal/invalid source/unknown以及生成完成后的上传/回执/签名错误均不发重试码。
- 关闭或scope/原图变化取消下一次，迟到预览不覆盖新版本；离页微调不承诺持久恢复。上架修图仍为0112持久队列。
- 下方新任务草案仅历史记录，已被替代，不交付实施。

## 同步预算证据
- 原生档案 `deployments/fankuang-list-20261009/native-source.tar.gz`：Android `HandheldApiClient.kt:398–400` read/write=90s，connect=20s；iOS `APIClient.swift:121–129` ai请求=180s，但`:166–167` resource=120s。
- 当前生成核单次120s（下载/检测12s/主生成40s/已有fallback60s/校验20s共用预算）。不能在90s内保证第二次完整处理，不降低核预算或阈值。
- 这些是归档证据，不是0.3.14安装包实测。现有同步POST和成功响应保持不变；helper仅分类已结束失败并提示下一次独立请求，不在单次端点叠加调用。

## 最小新契约（Codex原生与后端需一起实现后才可用）
- POST `/api/public/handheld/ai/retouch-preview-tasks`：`{client_op_id,location_id,sku_id?,expected_updated_at?,source_storage_path,instruction?}`；源图必须先使用现有上传接口保存，不能提交任意远程URL。已存SKU必须提供版本；新建草稿以actor/device/client_op_id+source hash绑定。
- 202 `{ok:true,data:{task_id,status:"queued",next_run_at}}`；同actor/device/op和相同指纹重放，同op不同输入409。actor/policy从设备+员工会话及现行AI授权取，不接受body伪造。
- GET 同路径`/$id`：`{task_id,status,attempts,max_attempts:3,next_run_at,error_code,storage_path?,signed_url?,mime_type?}`；结果仅对原actor/device及当前授权库位可见；失败不带图片。已完成只读签名，不重跑。
- DELETE 同路径`/$id`：原actor取消，持久tombstone；返回`cancelled`，processing迟到finish须token/lease/status fencing丢弃。
- Worker沿用`aiPrepareListingImage`和原guard/质量核，独立任务最多3次；`retouchRetryDelay`仅白名单网络/429/5xx/空stop/质量失败：30s、60s，429至少15min；全局并发与已上架队列共享6槽。auth/consent/invalid source/refusal立即终止；unknown fail-closed。
- 每次执行、完成、确认分别检查source hash/存在、SKU版本、原actor当前授权。成功只写预览和versioned receipt，不更新SKU/listing。Native须仍展示预览，用户确认再走现有有版本/权限检查的保存接口；原图版本变了不能确认旧结果。
- 无SKU草稿预览不允许绕过取消或关联到第二SKU。已上架后台任务仍用0112持久队列，不能转用预览路径强制published。

## 当前已实现回执门禁
- prepare-listing-image有效校验和上传后写version1/source validated_retouch/原actor/device；preserved_original不写。
- `handheld_item_audit`和`handheld_smart_create_ops`现有受控事务确认后一次性绑定SKU；不通过attach-images或客户端直写绑定；旧version0不能升级。
- 门禁仍要求真实输出文件、当前SKU引用、全部图片证明、识别/内容当前修订就绪；不批量建立历史readiness。
- 未实现以上已废弃的新任务接口/worker；原生顺序重试及腾讯部署由Codex实现验收，不声称微调离页自动恢复。