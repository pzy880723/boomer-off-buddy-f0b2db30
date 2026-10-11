# 已付款订单 → 门店手持提醒（阶段1，Lovable 代码/迁移状态，未发布腾讯）

迁移：`drizzle/migrations/0049_order_paid_handheld_notify.sql`（文件头含回滚语句）。测试：`bash tests/sql/order_paid_notify/run.sh`。

接口不变：`GET /api/public/handheld/notifications`、`GET /api/public/handheld/notifications/since`（设备 token + 员工会话；只返回本人有权限门店的数据）。

样例（mock，字段真实）：
```json
{"id":"<uuid>","kind":"order_paid","title":"新的已付款订单",
 "payload":{"order_id":"<uuid>","order_no":"N2026...","fulfillment_id":"<uuid>","fulfillment_code":"F...",
            "fulfillment_method":"shipping|pickup","sales_origin":"miniapp|app|web|unknown","paid_at":"2026-10-11T06:30:00Z"},
 "ts":"2026-10-11T06:30:00.123456Z","is_read":false,"action_status":null,
 "location_id":"<门店uuid>","location_name":"A店","ref_type":"fulfillment","ref_id":"<fulfillment uuid>"}
```
- `action_status`: null=待处理；`handled`=该门店已开始拣货；`voided`=订单已退款/取消，停止提醒。
- 一个跨店订单 = 每个门店一条（ref_id 唯一）；赠礼行不增加条数；重复支付回调不重复写。
- 列表分页：`?limit=1..100&cursor=<上页 next_cursor>`，按 ts 倒序；`next_cursor=null` 表示没有更多。
- 补偿拉取：`/since?ts=<上次 server_ts>&limit=`，按 ts 正序。为避免长事务晚提交漏单，客户端应以 `server_ts - 120 秒` 回看，并按 `id` 去重。
- 旧版 Android 遇到未知 `kind` 时应按普通消息显示或忽略，接口结构不变。

## 可靠增量（0052，2026-10-11）
- 新模式：`GET /api/public/handheld/notifications/since?cursor=latest` → `{items:[],next_cursor:"v2:<xid>:0"}`；之后 `?cursor=<next_cursor>&limit=100`，`has_more=true` 时立即继续拉。
- 只返回所有更早事务均已结束的变更（xid8 快照水位），长事务晚提交不会被越过；同 ts 由 (xid,seq) 区分。
- 同一消息 handled / voided / 本账号已读 变化会以最新状态再次下发（item.change_cursor 单调）。客户端按 id upsert；**只在首次见到该 id 且 kind=order_paid、action_status=null、is_read=false 时播报**，重下发不再播报。
- 每次 cursor 拉取前服务端尽力执行 `handheld_notify_reconcile(7,50)` 补写近7天缺失的付款提醒；重复付款回调（再次置 paid）也会补写；唯一索引防重。
- 旧模式 `?ts=` 与列表 `next_cursor` 行为未变（仍可能漏同 ts/状态变更）；列表新增 `next_page_cursor`（`ts|id`），回传到 `cursor` 即复合键分页。
- 自提 ready（handover_ready）/核销（handed_over）经既有履约状态触发器把提醒置 handled。
