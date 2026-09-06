# ERP APP 首页操作迁移 + 统一消息 首版

- [ ] A 消息：notifications 权限/分页/按人已读（is_read、action_status、location_name、ref_type/ref_id）、单条已读、read-all 持久化、dashboard 未读同口径
- [ ] B 客服：support_conversations/messages/participants/agents，共享接待（无独占）、internal 备注、handheld + storefront 双向 API、/customer-service Web 模块
- [ ] C 履约：session 权限修正、format=items、resolve?code=、ticket 出票、pick-scan 支持 fulfillment_item_id + 数量、shortage 申报与客户确认、complete 阻塞
- [ ] D 打印队列：print_jobs（fulfillment_id+ticket_type 唯一）、lease/ack/failed/unknown、paid 触发入队
- [ ] E 面单：只暴露 capability 状态，未配置返回 carrier_not_configured，不伪造 tracking
- [ ] OpenAPI 更新 + 测试

## 首版进度（2026-09-06）
- [x] A 消息中心：可见范围过滤 + 分页 + 按人已读 + dashboard 同口径
- [x] B 客服共享会话：员工/顾客 API + /customer-service Web 工作台
- [x] C 履约：session 权限、format=items、resolve、ticket、按行扫码、缺货阻断完成
- [x] D 打印任务队列：自动出票、设备互斥租约、ack/failed/unknown
- [ ] E 面单：仅能力状态 carrier_not_configured，待真实快递商户资质后接入
- [x] OpenAPI v1.11 + 契约测试 + 事务内数据库回归
