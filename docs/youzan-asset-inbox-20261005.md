# 有赞积分/券消息收件箱底座（2026-10-05）

范围：底座，不是全链路。没有扣账、加积分、发券、核销、写有赞。

- 表 `youzan_member_asset_inbox`（迁移 0024）：唯一 (kdt_id, event_id)；状态只有 pending/processing/retry/blocked/dead，**没有成功状态**。
- SQL 函数 ingest/claim/finish/requeue 仅 service_role 可执行；表只给 super_admin/hq_operator 通过 RLS 只读，anon 无权限。
- 服务 `src/server/youzan-asset-inbox.server.ts`：验签（常量时间比较，密钥缺失 503）、sha256(type+msg) 载荷指纹、冲突 409 不覆盖原行、指数退避（1 分钟起，封顶 1 小时，8 次后 dead）、错误只记类别。
- 处理结果：未知会员 → blocked unknown_member；已知会员 → blocked asset_adapter_not_connected。
- 管理员查看：`getYouzanAssetInboxStatus`（不返回 payload）。

## 未接公网入口
官方积分/券消息 type 枚举和 msg 结构未取得，不猜测。拿到官方合同后再在 `hooks/youzan-message.ts` 按白名单 type 分流到 `ingestAssetMessage`，现有交易/退款分支不动。

## 缺口
会员身份解析（对接腾讯 membership-youzan-links.sqlite 只读接口）、积分冻结/消耗/解冻/回补、券查询/占用/核销/退还、对账、worker 调度。

## 只读观察处理器（0028/0029）
- 通知只触发重新查询；外层 kdt_id/yz_open_id 不在签名范围，只作线索。
- `src/server/youzan-asset-observer.server.ts`：授权 active 店铺 → 注入 `resolveIdentity`（腾讯 membership-youzan-links 映射，只收 kdt_id+yz_open_id，不新建会员）→ 注入 `queryAsset`（必须经 youzanFetch 固定出口只读）→ 校验返回店铺/身份/券号一致 → `youzan_asset_observation_record`。
- 依赖未注入：blocked identity_resolver_not_connected / asset_query_not_connected。
- 表 `youzan_member_asset_observations`：只读外部观察，不是本地可花余额，不写钱包/pos_customer_coupons/积分账本。
- 原子 RPC：claim_token+lease fencing → 授权店铺 → 乐观 row_version → observed_at 单调；旧结果 older_observation，inbox 置 blocked superseded_by_newer_observation；成功 inbox 置 blocked observed_asset_adapter_not_connected（仍无成功态）。
- 权限：RPC 仅 service_role；表仅 super_admin/hq_operator 经 RLS 只读，anon 无权限。

## 推送签名协议（现行合同 ZnS3wHtzOiuGNMkB31bcHr9jnUc）
- 有 `Event-Sign` 头：只验 MD5(client_id + 原始 HTTP body + client_secret)，失败 401，不回退 body.sign；Client-Id/Event-Type 头若存在须一致；body.client_id 严格标量。
- 无头：legacy body.sign（按解码 msg），入库即 blocked legacy_signature_readonly_hint，不进资产处理。
- 路由 `readYouzanPush` 只读一次 request.text()，原文传给 `dispatchAssetPush`。
- 积分只读查询：`youzan-points-query.server.ts`（points.get 1.0.0 + is_query_points_account_version=true，必须固定出口）。入参待腾讯真实 code=200 核对。L 店不在积分查询扩展点、冻结 4.0.0 不含 L：ERP 独立抵扣保持关闭。

## 0030 积分版本守卫
- points 观察以 points_account_version（numeric 精确比较，支持 ≤20 位字符串）为准：低版本 → older_observation + inbox superseded_by_newer_observation；同版本不同 point → version_conflict + inbox points_version_conflict（不覆盖）；同版本同值 → same_version_observed（快照不动）；高版本即使查询时间更早也更新，observed_at 取较大值不倒退。
- point 必须非负整数（≤15 位），版本必须非负整数；否则 22023。
- fencing（claim_token+lease）与 expected_row_version 保留；coupon 仍按 observed_at。
- TS 处理器需识别新结果 version_conflict / same_version_observed（由 Codex 在其分支补，RPC 已自行结束 inbox）。

## 0031 身份守卫
- 已有快照 customer_id 与本次可信映射不同 → identity_conflict，inbox blocked identity_mapping_conflict（清 claim/lease），快照不覆写；积分/券、同版本/高版本均适用。TS 计数由 Codex 接。
