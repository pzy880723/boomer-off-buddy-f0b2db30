# 会员积分/优惠券同步有赞：只读差距审计 + 最小安全实施路径

当前 commit：`f0cc7d9b`。本轮只做了读取：没有写有赞，没有写数据库，没有发券或加积分，也没有部署。

## 1. 只读结论（已查证）

| 已确认方案里的组件 | 是否存在 | 证据 |
|---|---|---|
| member_channel_links（ERP 会员 ↔ 有赞用户） | 不存在 | public 下没有这张表，代码里没有引用；commerce_customer_identities 里只有 phone 身份 |
| benefit mappings（ERP 券模板 ↔ 有赞券活动） | 不存在 | 没有对应表；commerce_coupon_definitions 没有有赞字段 |
| 会员资产 outbox（积分/券推往有赞） | 不存在 | 现有 outbox 都是商品、库存、图片、渠道库存，没有会员资产这一类 |
| 积分入站回流（有赞变动回写 ERP）和退款回补 | 不存在 | 代码里没有任何 youzan.scrm.* 或 points.* 接口调用 |
| 有赞券核销防双花 | 不存在 | pos_customer_coupons 的 external_provider/external_id 有字段，但 0 行在用；只有 commerce_reserved_coupon_guard 负责 ERP 内部订单占用 |

可以复用的部分：
- 唯一会员主档 commerce_customers（不另建平行主档）。
- 积分钱包 pos_customer_wallets 加流水 commerce_points_ledger（idempotency_key 唯一）。
- 正规调整服务 commerce_admin_adjust_membership，带审计和幂等。
- 券实例 pos_customer_coupons（code/idempotency_key 唯一，有 external_* 预留字段）。
- 有赞固定出口 youzanFetch，以及现有 outbox 的 claim/finish 模式（参照 handheld_youzan_item_sync_outbox）。

目标账号（customer 1b9676d9…，尾号 3310）ERP 当前状态：3000 积分（1 条流水），3 张有效券 c760ce03/548a1d77/ac281f2b。以上已发放，不再在 ERP 重复发放。

## 2. 积分换算配置（已查证）

- free/explorer_monthly/explorer_annual 三个方案都是：points_redemption_enabled=false，points_per_unit/unit_fen 为 NULL，也就是没有已确认的积分兑人民币比例。
- 单笔上限 cap_rate 读回为 1.0000。最初迁移里是 0.15，现在已经是 100%，相当于"取消 15% 上限"已落库。
- 有赞侧：10 月 3 日的只读 youzan.scrm.pointdecution.get/1.0.0 返回抵现插件值 0、状态 0（关闭），没有门槛和上限。
- 结论：ERP 和有赞都没有已确认的抵现比例。本计划不设定任何比例，"开通积分抵现"需要用户先给出比例。

## 3. 双花风险（必须指出）

- **积分**：如果只是把 ERP 的 3000 余额复制到有赞，同时 ERP 小程序/POS 仍按自己的钱包抵扣，两边各有 3000，可以各花一次。必须只保留一个可花账本：要么有赞是唯一可花余额、ERP 只做镜像；要么 ERP 是唯一账本、有赞每次扣减都同步回写。不能两边独立可花。
- **券**：把 3 张 ERP 券在有赞再发一份，一个人就有 6 张可用。ERP 券必须在有赞发放成功后作废（void，并记录 external_id），或反过来有赞核销后同步把 ERP 券标记为 used。目前两种都没有实现。

## 4. 最小安全实施路径（获批后再做）

1. **身份链接**：新增 member_channel_links(customer_id, provider='youzan', kdt_id, yz_open_id, 唯一约束)。按手机号调用有赞客户查询来绑定；查到多个或查不到时不绑定。
2. **资产 outbox**：新增 member_asset_sync_outbox，按 (customer_id, asset_kind, source_ledger_id/coupon_id) 唯一，幂等键沿用 ERP 流水/券的 idempotency_key。只由腾讯固定出口 worker 认领执行。
3. **积分推送**：使用有赞积分增加接口（候选 youzan.crm.customer.points.increase 或 youzan.scrm.customer.points.increase，版本以 Codex 固定出口实测为准），传入 ERP 幂等键作为业务单号。推送成功后，ERP 钱包改为有赞镜像，ERP 侧停止独立抵扣。
4. **券推送**：ERP 模板映射到有赞的隐藏券活动（benefit mapping），用有赞发券接口按用户发放。成功后 ERP 券写入 external_provider/external_id 并置为 void；失败则保留 ERP 券、不重复发放。
5. **回流**：订阅有赞积分变动和券核销/退款消息，或定时对账，回写 ERP 流水，退款回补同样走幂等键。
6. **抵现开通**：比例确认后，写有赞抵现规则（pointdecution 对应的更新接口），同时把 ERP 方案设为同一比例，或在 ERP 关闭抵扣，避免两套规则并存。
7. 验证顺序：只针对 3310 测试账号；有赞写入只走固定出口；每一步读回双方余额和券数。

## 5. 真正阻塞

- 有赞权限：积分规则读取（points.rule.list）、抵现规则读写（pointdecution）、积分增减、按用户发券、客户按手机号查询，这几项权限要等 Codex 从固定出口实测确认。代码里还没有任何 scrm/ump 调用。
- 积分兑人民币比例未确认（ERP 为 NULL，有赞为 0 且关闭），需要用户给出。
- 需要用户选定唯一可花账本（有赞或 ERP），否则一定会双花。
- 有赞侧是否有隐藏的测试券活动可供映射，尚未查证。

## 技术细节

- 查证来源：information_schema 表清单；rg 检索 youzan.(scrm|ump|crm|points) 只命中 docs/unified-pos-20261003.md:86；commerce_membership_plans 读回；pos_points_rules 函数定义；pos_customer_coupons 的 external_provider 非空 0 行；commerce_reserved_coupon_guard 是 BEFORE UPDATE/DELETE 触发器。
- 新增迁移按惯例先在 BEGIN/ROLLBACK 中验证再应用；新表都开启 RLS，只允许 service_role 写。
