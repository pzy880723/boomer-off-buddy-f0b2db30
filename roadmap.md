# Roadmap

## 当前任务：全额退款订单关单（仅数据库 + 隔离 SQL 测试）
- [x] 核查退款成功路径（普通退款 / 缺货意图）、订单/履约约束
- [x] 隔离库测试：全退/部分/失败/重复/多次部分合计全退/已发货历史
- [x] 迁移：全额退款原子 closed + 履约写 RPC 保护 + 历史回填（留审计）
- [x] 只读验证 + 订单来源字段说明
- [x] 增量复核：订单总额核验、多付款汇总、exception/handed_over 子写保护、退款与履约并发串行

## 当前闭环：缺货申报 → 客户确认 → 自动原路退款（v1）

约束：本轮严禁真实短信发送、真实订单退款、客户数据批量写入、腾讯部署；worker/业务短信生产开关默认关闭；旧缺货不自动批处理；不得破坏旧腾讯版。

- [ ] 1. 只读核对：现有 shortages / after_sales / refunds / payments / notifications / 发货事务 / TC3 短信
- [ ] 2. 迁移：客户通知表、短信 outbox（业务模板）、退款意图/任务表、refund 状态 CHECK 扩展、报价版本与分摊字段；含 GRANT
- [ ] 3. 缺货申报事务（原子锁定可申报数量 + 待办 + 通知 + 短信 outbox）
- [ ] 4. 客户确认事务（归属 + 报价版本 + 唯一退款意图 + 持久退款任务）
- [ ] 5. 退款 worker（原支付通道、相同商户退款号、租约、未知先查；默认关闭）
- [ ] 6. 门店子单详情 + 手工发货（快递公司/单号/数量）+ 缺货申报入口（ERP UI，按 Figma 25:2）
- [ ] 7. 客户端 API：shortages 列表/详情/confirm-refund、notifications 列表/已读
- [ ] 8. 金额分摊：按实付分摊、整数分尾差固定、并发上限、整组未发货才退该组运费
- [ ] 9. docs/shortage-refund-contract-v1.md 字段合同
- [ ] 10. 红绿测试 + 类型检查 + schema 权限检查证据

## 待办（阻塞在用户侧）
- 腾讯业务短信模板配置、worker 生产开关开启、腾讯部署（由 Codex 验收）

## 已挂起（不在本轮）
- GO 本人 JWT 线下补录合同（设计已修订，等批准）
- 有赞凭据在腾讯侧恢复（需用户手工注入）

## v1 已落地（commit 4094c70 / 9e20880）
- [x] 迁移 0000_shortage_refund_v1 + 0001_shortage_refund_revoke_anon（已应用）
- [x] RPC shortage_report_v1 / shortage_confirm_refund_v1（仅 service_role）
- [x] 客户端四个接口 + Case 合同 + 通知已读
- [x] ERP 页面 /orders/fulfillment/$orderId（手工发货 + 缺货申报）
- [x] docs/shortage-refund-contract-v1.md

## 仍未开启（阻塞项）
- [ ] 退款执行 worker（消费 commerce_refund_intents）— 生产开关默认关闭，未实现执行器
- [ ] 腾讯业务短信模板配置（shortage_reported 等）— outbox 记 template_missing
- [ ] 腾讯生产部署（由 Codex 单独验收）

## 2026-10-05 清理后剩余 8 条
- [x] 1 分批缺货退款（quote 按件顺延 + 最后一批退组运费）
- [x] 2 补录销售：同 op 载荷不同 → 409；并发 23505 → 回放/冲突
- [x] 3 smart-create：只读校验并行 + Server-Timing
- [x] 4 标签缺失：当前无丢失路径，关单
- [x] 5+7 推荐卡只读 API（items/{id}/recommendation-card）
- [x] 6 会员购买上下文：事实契约审计文档（实施待与腾讯 customer-purchase-notes 对齐）
- [x] 8 门店二维码配置：迁移 0021 已应用 + API + 权限测试
- [ ] 外部：腾讯部署、store-qr 私有桶与真实二维码、ERP 网页商品卡 UI（Codex 本地）

- [x] 商品卡：schema/claim 审核失败带原因重写一次，安全原因日志（2026-10-05）
- [x] 积分比例 100:100 写入 3 个方案（不开 enabled），只读追踪报价/扣减/退款幂等
- [ ] 迁移 0030：points 观察按 points_account_version（numeric）防倒退/同版本冲突阻断；仅 SQL/文档
- [x] 门店二维码录入只读核查（2026-10-05）
