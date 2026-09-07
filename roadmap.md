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

## 门店日目标 / 线下补录（2026-09-07）
- [x] 迁移：store_monthly_target_plans / store_daily_targets / store_target_audit_logs / store_offline_sales_entries / store_offline_sales_audit_logs / go_identity_links（含 GRANT + RLS）
- [x] 月目标→日目标拆分算法（整数分、精确合计、周末/单日权重、过期与锁定日不重算、未达标不摊余）+ 24 项单测
- [x] 日汇总口径（Asia/Shanghai、已付款毛额-运费、incomplete 原因）
- [x] handheld API：/store/daily-summary、/store/offline-sales（GET/POST 幂等）；OpenAPI 1.15.0
- [x] ERP 后台 /shop-mgmt/targets 配置页（HQ 可写，店员只读）
- [ ] GO(bef32724) Supabase JWT ↔ ERP 身份/门店桥接：仅落 go_identity_links 登记表，验签与换票未实现
- [ ] 有赞订单同步中断修复（Worker 超时自动重置，自 08-29 无新订单）
- [ ] 有赞退款数据源接入（当前一律 incomplete）

## 销售仪表盘后端（2026-09-07）
- [x] sales_dashboard_report 聚合 RPC（净销售/渠道/趋势/待办，Asia/Shanghai）
- [x] src/lib/sales-dashboard.functions.ts + 授权（HQ 全部/单店，店员限授权门店）
- [x] 契约测试（区间解析、AOV、warning 不造 0）
