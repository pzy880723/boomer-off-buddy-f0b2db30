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
