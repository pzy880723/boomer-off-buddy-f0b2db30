# GO 线下补录收尾 · 只读核查结论 + 最小最终 API 合同（未实施）

本轮只读。未写任何业务数据、未建用户、未重置同步游标、未改有赞配置或权限、未部署、未公布任何密钥。
待你批准后，唯一动作是把下方合同落成新文件 `docs/go-offline-sales-contract-v1.md`（草案，明确标注「未实施」），不改其他项目的 plan.md，不附带其他业务。

## 一、主线现状核对（对照 20d098f 的《GO 补录安全合同（修订版）》）

已具备（可复用）：
- 表 `store_offline_sales_entries`：`location_id / business_date / channel(cash,pos_card,wechat_qr,alipay_qr,bank_transfer,other) / amount_fen / order_count / evidence_* / youzan_exclusion_basis(4 值含 unverified) / youzan_excluded_tids / status(active,voided) / client_op_id / created_by / voided_*`，已有唯一约束 `(location_id, client_op_id)`。
- 审计表 `store_offline_sales_audit_logs`，action 已含 `create / update / void / replay_idempotent`。
- 权限基线：两表已 `REVOKE ... FROM anon, PUBLIC`；RLS 已启用；HQ 全权策略 + 门店员工按 `user_location_perms` 的 SELECT / INSERT（INSERT 强制 `created_by = auth.uid()` 且 `status='active'`）。
- GO 身份链路：`authenticateGoActor` 用固定 issuer 实测 token、GO 可信排班 RPC 得当日门店、ERP 侧 `go_identity_links` 只做否决、实时读 `user_roles`；`scopeForActor` 已把「当日排班门店」收敛成范围。
- 日汇总 `loadDailySummary` 已把 `offline` 与 `youzan` 分列，`achieved_fen` 为两者相加。

仍然缺（合同未实现部分）：
- **无任何 GO 写入路由**。`src/routes/api/public/go/` 下只有 `session / authorization / authorization-ack / scope-sync / store/daily-sales`，全部只读。GO JWT 目前无法补录。
- **无原子 RPC**。`createOfflineEntry / voidOfflineEntry`（`src/server/store-targets.server.ts`）仍是分开的 DB 调用：业务行与审计行两次写；审计 insert 的 error 未检查；幂等是「先查后插」竞态；作废只按 entry id 更新，无 `location_id / created_by / status='active'` 条件。
- **无 `payload_fingerprint`**（同 client_op_id 异载荷无法判 409）、**无 `supersedes_entry_id / superseded_by_entry_id`**（无更正链）。全库检索无 `store_offline_sales_create` / `store_offline_sales_void` 等 RPC。
- **无「未核验」分列口径**：`unverified` 条目在日汇总里与其他补录混在同一 `offline.amount_fen`，未单列计数/金额，`completeness.reasons` 也不标注。

## 二、纯后台安全配置能力（存在性确认）

`YOUZAN_CLIENT_ID`、`YOUZAN_CLIENT_SECRET`、`YOUZAN_PROXY_URL`、`YOUZAN_PROXY_TOKEN` 四项**均存在**（仅名称，值加密不可读）。后台仍只能列名称：不支持导出、跨环境同步或注入到腾讯环境。要恢复腾讯侧凭据仍需你本人从可信保管来源取值写入服务器环境文件。

## 三、最小最终 API 合同（待批准后写入 docs/go-offline-sales-contract-v1.md）

鉴权一律 GO 本人 JWT（复用 `authenticateGoActor`），不接受设备令牌，不放宽权限。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/public/go/store/offline-sales` | 新建补录 |
| POST | `/api/public/go/store/offline-sales/$id/void` | 作废本人记录 |
| POST | `/api/public/go/store/offline-sales/$id/amend` | 更正 = 作废 + 重建（同事务） |
| GET | `/api/public/go/store/offline-sales?date=` | 列出本人当日本店记录 |

请求体（create / amend 同构）：
`client_op_id`(必填)、`business_date`、`channel ∈ {cash, pos_card, wechat_qr}`、`amount_fen > 0`、`order_count ≥ 1`、`evidence_type` + `evidence_ref|evidence_url`（非 `manual_declaration` 时必填）、`youzan_exclusion_basis`、`youzan_excluded_tids`（`reconciled_against_youzan` 时必填）、`note`。

硬规则：
1. **门店与日期**：`business_date` 必须等于服务端 Asia/Shanghai 当日，否则 400；门店取当日唯一排班门店，排班缺失/多店不唯一 → 403，不自动取第一个；提交时按服务端时刻重新解析，不复用会话缓存。
2. **首版范围**：仅 `cash / pos_card / wechat_qr`，仅正数；负数、退款、冲账一律 400。
3. **本人限定**：作废/更正条件必须是 `id = ? AND location_id = ? AND created_by = ? AND status='active'`，0 行影响 → 409/403，绝不返回成功。跨人/跨日更正走既有 ERP 后台权限流程（`super_admin` / `hq_operator`），不经 GO JWT 放宽。
4. **原子性**：业务行 + 审计行在同一 `security definer` RPC 事务内写入；审计写失败 = 整体失败回滚，接口报错。
5. **幂等**：唯一约束 `(location_id, client_op_id)` 为唯一真源。同 `client_op_id` + 同 `payload_fingerprint` → 回放原记录 `replayed=true` 返回 200；异载荷 → 409 `client_op_id_conflict`，不改写原记录。回放审计记 `replay_idempotent`，`actor_id` 记本次调用者，原 `created_by` 不变。
6. **更正链**：新记录 `supersedes_entry_id` 指向被作废记录，旧记录 `superseded_by_entry_id` 回指；两步同一事务，失败则旧记录保持 `active`、不留孤儿；重试按 `client_op_id` 幂等回放。
7. **有赞排重是人工申报**：系统不做自动去重。日汇总必须把 `unverified` 单列计数与金额，并在 `completeness.reasons` 标注存在未核验补录，不得静默混入「已核对」业绩口径。

## 四、需要一次迁移（待批准后才写）

新增列 `payload_fingerprint text`、`supersedes_entry_id uuid`、`superseded_by_entry_id uuid`；新增 `security definer` RPC `store_offline_sales_create / _void / _amend`，执行权仅 `service_role`（`anon/authenticated` 无执行权）；日汇总补 `offline.unverified_*` 字段。

## 待确认
- 批准「先写 docs 草案、迁移与路由留到下一轮」这个顺序？
- 作废是否限时窗（仅当日可作废，次日起走 ERP 后台）？
