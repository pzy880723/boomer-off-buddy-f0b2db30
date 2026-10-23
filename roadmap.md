# 待办+通知修复（backend only，腾讯用户自验）

## 本轮批量修订
- [x] 当前店真实库存、展示/销售资格、移出无变化、未知旧提示及编辑权限边界修订；相关回归50/50、自动构建通过
- [x] 补充 123456/123999 冲突、纳秒/时区等价、客户端版本 CAS 与 HQ 当前库位回归实证
- [x] 恢复商品卡入口、翻筐乐合并操作、特色默认不改
- [x] 明确当前库位，账号/角色/查询变化清理选择和回执
- [x] 冻结提交和原版本重试，精确 CAS 与 returning 核验
- [x] 红绿测试 36/36、自动构建通过；不修改真实商品或腾讯独立文件
- [ ] 登录态完整界面验收：当前本人无匹配账号，禁止任意选择他人身份或真实商品试写

## 历史事项（前轮已交付，本轮不重跑）

- [x] 1. work_items/pending_counts 移除 stock_sync/channel_sync 分支（服务端，非客户端 filter）
- [ ] 2. 同步失败 → 真实 inv_handheld_notifications（幂等回填 7 天 + 持续投影 failed/恢复；跳过 8 月两条测试队列；location 优先+shop 映射验证，缺/歧义不广播；详情脱敏+商品名+状态+同步中心；成功后 action_status 恢复不再列待处理；unread_counts.system 同源；列表 category=system 服务端过滤+微秒游标+标读 scope；badge_counts 新可选字段合同）
- [ ] 3. measurement 个人忽略：云端表+RLS+service-role-only 写；POST/DELETE /api/public/handheld/work-items/measurement-dismissals {location_id,task_id,request_version}；session 取 user；校验门店授权、已完成 409；work-item 测量行加 measurement_task_id/request_version/can_ignore；用 requester 事件版本区分复用 task；混合会话只忽略测量；GET include_ignored/ignored_only；不改 completed/cancelled 语义
- [ ] 迁移先测后 apply；revoke PUBLIC/anon/authenticated execute；service-role 沿现有模式
- [ ] 测试：外店/其他用户/replay/新申请/混合会话/计数分页一致/失败通知可见/去重恢复
- [ ] 禁触：识别/抠图/打印/订单/有赞库存写；不做发布重试
- [ ] 交付：commit+文件+测试+接口示例
