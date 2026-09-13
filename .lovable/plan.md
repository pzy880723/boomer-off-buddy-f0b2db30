# 本任务只读收尾：有赞凭据安全恢复能力 + GO 本人 JWT 补录最小合同

范围仅此两项。不实施退款/售后计划，不改公网 release、队列、退款流程。腾讯基线仍为 `1e7a4ee-compressed-images-20260913`，本轮未部署。

## 一、我是否有“安全配置导出 / 同步 / 直接注入腾讯”的能力

明确答复：**没有。**

实查能力边界（仅核对名称，未读取任何值）：

- 我能列出安全配置中的名称：`YOUZAN_CLIENT_ID`、`YOUZAN_CLIENT_SECRET`、`YOUZAN_PROXY_URL`、`YOUZAN_PROXY_TOKEN` 四项均存在。
- 我**不能**读取、解密、导出或转发任何值：值为加密存储，工具只返回名称。
- 我**不能**新建/修改已存在的同名配置项（已存在即拒绝），也**不能**把值写入腾讯 `shared/.env`、PM2 dump 或任何远端。
- 平台没有“Lovable 安全配置 → 腾讯服务器”的官方同步通道；两边是各自独立的配置面。
- 我拒绝构造任何临时导出接口、回显端点或代码路径来搬运密钥（那等于把密钥落进代码与公网面）。

### 最短安全操作路径（必须由你本人完成）

1. 打开 **Project Settings → Secrets（项目设置 → 安全配置）**，对 `YOUZAN_CLIENT_ID`、`YOUZAN_CLIENT_SECRET`、`YOUZAN_PROXY_URL`、`YOUZAN_PROXY_TOKEN` 四项逐一点击显示/复制。此面板是唯一能取回值的位置。
2. 通过 SSH 直接在腾讯服务器上用编辑器写入 `shared/.env`（不要用带值的命令行参数，避免落入 shell history 与进程列表）。写完执行 `chmod 600 shared/.env`。
3. 重载进程使配置生效（PM2 需带 `--update-env`），不重置任何游标。
4. 生效验证只做只读探针：一次授权/只读 API 调用确认拿到真实 `code=200`；不得调用有赞商品写接口。
5. 通过后再做单店单窗口有界 canary，人工核对游标推进，然后分批开放失败窗口；28 条失败游标不得一次性重置。
6. 全过程密钥不进入聊天、日志、命令参数、代码与任何公开接口。

不新建有赞应用，不改权限、退款与租约。

## 二、GO 本人 JWT 补录现金/POS/微信 —— 最小既有业务合同

目标：原生已有每日目标卡，补上补录入口；不新建 App 独立后台，不新增业务逻辑分支，全部复用既有实现。

### 复用的既有资产（实查）

- 服务端：`src/server/store-targets.server.ts` 的 `createOfflineEntry`（含幂等回放 + 审计）、`voidOfflineEntry`（必填 reason + 审计）、`listOfflineEntries`。
- 表：`store_offline_sales_entries`、`store_offline_sales_audit_logs`（迁移已应用；实查当前 0 条补录，历史干净）。
- 鉴权：`src/server/go-bridge.server.ts` 的 `authenticateGoActor` + `scopeForActor`（固定 GO issuer 实查 JWT，门店由 GO 排班 + `go_shop_location_links` 决定）。
- 现有唯一补录通道 `/api/public/handheld/store/offline-sales` 走手持设备令牌，GO JWT 打不通；`voidOfflineEntry` 目前没有任何路由调用。

### 建议合同（待批准后才实施）

1. `POST /api/public/go/store/offline-sales` — 创建
   - 入参：`client_op_id`（必填，幂等键）、`business_date`(yyyy-mm-dd)、`channel` ∈ `cash|pos_card|wechat_qr|alipay_qr|bank_transfer|other`、`amount_fen`（非零整数分）、`order_count`、`evidence_type` ∈ `pos_receipt|payment_screenshot|bank_slip|handwritten_slip|manual_declaration`、`evidence_ref`/`evidence_url`（非口头申报必须至少一项）、`youzan_exclusion_basis` ∈ `device_not_youzan|operator_declared|reconciled_against_youzan|unverified`、`youzan_excluded_tids[]`、`note`。
   - 门店：一律由排班/映射推导，**忽略 body 里的 location_id**；非本人当日门店 403。
   - 返回：`{ ok:true, data:{ entry, replayed } }`；重复 `client_op_id` 回放原记录且 `replayed=true`，不产生第二条。
2. `GET /api/public/go/store/offline-sales?date_from=&date_to=` — 只看本人当日门店的补录列表（复用 `listOfflineEntries`）。
3. `POST /api/public/go/store/offline-sales/:id/void` — 作废，必填 `reason`，仅限同门店记录；复用 `voidOfflineEntry`。
4. **更正 = 作废 + 重建**，不原地改金额，保留完整审计链。
5. 幂等硬化：为 `store_offline_sales_entries(location_id, client_op_id)` 加唯一索引，冲突时回放（迁移需单独批准）。
6. 防有赞重复：靠 `youzan_exclusion_basis` + `youzan_excluded_tids` 申报，并在日汇总里与有赞口径分列（`offline` 与 `youzan` 两块互不相加进同一来源）。
7. 审计：创建 / 回放 / 作废均写 `store_offline_sales_audit_logs`，记录 actor、门店、业务日、`client_op_id`、前后快照。
8. 权限边界不变：月目标/日目标配置写操作仍只限 ERP 总部角色（`super_admin`/`hq_operator`）；GO 侧只能补录与查看自己排班门店；现有 `/api/public/go/authorization`、`/session`、`/daily-summary` 三条接口保持原样不动。

### 待你确认

- 批准上述三条 GO 路由与唯一索引迁移？
- 补录是否允许负数金额（当前实现只禁 0）？
- 确认“更正”采用作废 + 重建。
