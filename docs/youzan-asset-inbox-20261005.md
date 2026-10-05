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
