# 腾讯切换前只读盘点（旧生产 Lovable/Supabase 现状）

只读执行：未修改代码/SQL/配置/secret，未创建导出文件，未停任何 cron/队列/worker，未发布，未调用任何第三方写入/支付/退款，**未向腾讯生产写入或部署**。
证据分三类：【实查】= 本轮数据库查询或文件读取结果；【代码推断】= 读源码得出；【未知】= 本轮无法核实。

## 1. 版本水位【实查】

- 当前 commit：`933e0bb337c8fb58fbfd2cc764c3745599d759ae`，工作区干净。
- 仓库迁移文件 155 个，最后一个文件：`20260908081317_3b921feb-3d29-4792-aea4-d644e5375605.sql`。
- 数据库已应用最新版本：`20260908081317`（前序 `20260908070711` / `20260908002040`）。文件与库最新版本一致。

## 2. 内嵌数据库当前调度与队列【实查】

cron（凭据已剥离，仅给 hostname + 路径，未输出原始 command/headers）：

| jobid | 名称 | schedule | active | 目标 hostname | 路径 |
|---|---|---|---|---|---|
| 1 | youzan-sync-30min | `*/30 * * * *` | false | project--2158bffa…lovable.app | /api/public/hooks/youzan-sync |
| 2 | youzan-stock-worker-tick | `* * * * *` | true | project--2158bffa…lovable.app | /api/public/hooks/youzan-stock-worker |
| 3 | channel-sync-worker-tick | `* * * * *` | true | project--2158bffa…lovable.app | /api/public/hooks/channel-sync-worker |
| 4 | commerce-release-expired-every-minute | `* * * * *` | true | project--2158bffa…lovable.app | /api/public/hooks/commerce-release-expired |
| 5 | listing-image-worker-every-minute | `* * * * *` | true | erp.boomeroff.com | /api/public/hooks/listing-image-worker |

队列积压（按状态计数）：

- `youzan_stock_sync_queue`：done 904，failed 5，**无 pending/running 行**。
- `youzan_order_sync_cursors`：done 8，failed 16。
- `channel_sync_outbox`：succeeded 2。
- `inv_listing_image_jobs`：succeeded 5。
- `go_scope_sync_outbox`、`print_jobs`：0 行。

近 48 小时出站 HTTP 结果：200 × 1080、401 × 360（401 集中在需要 apikey 的那条 worker 路由；**说明该 worker 实际业务未执行**）。scheduler 记 succeeded 只代表请求入队，不代表业务成功。

## 3. 回调入口与幂等键【代码推断，路径与 hostname 实查】

支付/退款通知（hostname 均为当前 ERP 部署域，未读任何 secret 值）：

- `/api/public/storefront/payments/wechat-notify` — `src/routes/api/public/storefront/payments.wechat-notify.ts`
- `/api/public/storefront/payments/callback/$provider` — 同目录 `payments.callback.$provider.ts`
- `/api/public/pos/payments/callback/$provider` — `src/routes/api/public/pos/payments.callback.$provider.ts`

幂等/唯一键位置：

- 普通微信收款/退款：`src/server/ordinary-payment-notifications.ts:18,26` 以 `out_trade_no ↔ merchant_order_no`、`out_refund_no ↔ merchant_refund_no` 双向核对后再入账；查单/关单/退款路由收敛在 `src/server/ordinary-payment.server.ts`（`commerce_payments.merchant_order_no`、`commerce_refunds.merchant_refund_no`）。
- POS 支付：`src/server/pos-payment.server.ts:251,271,302,346` — `client_op_id` 与 attempt 一一对应，`out_trade_no` 唯一定位，回调重放不重复扣款/重复销售。
- 有赞/库存/渠道同步：`src/lib/youzan-sync.functions.ts:530,1510,2128,2237,2293,2324,2407` 与 `src/lib/youzan-offline-products.functions.ts:90,131` 全部 `onConflict: "sku_id,shop_id"`；分类分组 `src/lib/youzan-category-groups.server.ts:472` 用 `category_id,hq_shop_id,channel`；销售提交幂等在 `src/lib/youzan-sale.server.ts`（`commit_sale` 返回 `idempotent`）。
- 历史普通收款/分账兼容点：`src/server/ordinary-payment.server.ts:36-49`（历史普通订单继续用原商户查单/退款，与新单模式解耦）；`src/server/payment-route.ts`、`src/server/ordinary-payment-config.ts` 保留旧分账通道配置。

## 4. 以 2026-09-09T03:57:41Z 为基准的增量【实查】

| 对象 | 当前总数 | 该时刻后新增 | 该时刻后更新 |
|---|---|---|---|
| auth.users | 4 | 0 | 1 |
| user_roles | 4 | 0 | **缺可靠水位**（无 updated_at） |
| commerce_orders | 2 | 1 | 1 |
| commerce_order_items | 3 | 1 | **缺可靠水位**（无 updated_at） |
| commerce_payments | 2 | 1 | 1 |
| commerce_refunds | 0 | 0 | 0 |
| commerce_customers | 2 | 0 | 1 |
| commerce_membership_orders | 1 | 0 | 0 |
| commerce_membership_entitlements | 0 | 0 | 0 |
| inv_skus | 528 | 0 | 0 |
| inv_stocks | 8 | **缺可靠水位**（无 created_at） | 0 |
| inv_stock_movements | 13 | 0 | **缺可靠水位**（无 updated_at） |
| storage.objects | 1214 | 3 | 3 |

未输出任何具体用户/交易记录。注意：`storage.objects` 从此前盘点的 1211 增至 1214，说明**导出时刻之后旧生产仍有写入**，最终切换必须再做一次增量。

## 5. 仍依赖 Lovable/外部运行时的函数【实查代码位置】

Lovable AI Gateway（`https://ai.gateway.lovable.dev` + `LOVABLE_API_KEY`）：

- `src/lib/translate.functions.ts:24-28`
- `src/lib/tariff.functions.ts:38-43`
- `src/lib/meruki-parse.functions.ts:170-175`
- `src/lib/domestic-recognize.functions.ts:8-12`
- `src/lib/mobile.functions.ts:338-353`
- `src/lib/sku-image.functions.ts:13-16`
- `src/server/handheld-ai.server.ts:7-11`
- `src/server/handheld-editorial.server.ts:4,88`
- `src/lib/recognize.functions.ts`、`src/server/product-recognition.server.ts`（同一 gateway 路径）

抓取：`src/lib/sku-image.functions.ts:53`（`api.firecrawl.dev/v2/search`）。

硬编码 Lovable/Supabase 域名（切换后会继续指向旧域）：
`src/lib/sku-media.ts`、`src/lib/handheld/openapi.ts`、`src/components/youzan/message-push-panel.tsx`、`src/lib/go-bridge/constants.ts`、`src/routes/__root.tsx`；数据侧历史旧域名残留在 `inv_skus.image_url` / `image_paths`、`japan_parcel_items.item_image_url`、`commerce_order_items.image_snapshot`（此前盘点结论，本轮未复查）。

**cron job 1-4 的目标 hostname 仍是 Lovable 预览域**，这是最强的运行时耦合点。

## 6. 建议的最终切换顺序（仅建议，本轮不执行）

1. 冻结外部触发：先停 cron job 2/3/4/5 与腾讯侧 systemd timer，确认 `net._http_response` 无新增。
2. 排空队列：确认 `youzan_stock_sync_queue`、`channel_sync_outbox`、`inv_listing_image_jobs` 无 pending/running；先处理现存 5 + 16 条 failed，决定重放还是作废。
3. 进入**停写窗口**（需要你确认时长与时段）：旧生产切只读，三端停止下单/收款。
4. 最终增量：数据库增量 + Storage 增量（当前已知至少 3 个新对象），逐表比对第 4 节口径。
5. 单写者切换：ERP/消费者端/小程序配置指向腾讯，旧生产保持只读至少 30 天。
6. 回调改指：支付/退款通知与有赞回调的 notify URL 改到腾讯域，验证幂等键在新库仍唯一。
7. 三端真实登录 + 一笔小额真实支付 + 一笔退款验收，通过后再恢复写入。

必须由你明确确认后才执行的项：停写窗口时间、cron/timer 停用、notify URL 变更、真实支付/退款验收、旧生产转只读。

## 7. 未知项

- 三端真实登录/支付、最终增量、单写者、生产切换均未验收（与你的判断一致）。
- 平台侧是否存在仓库外的 Edge Functions / Realtime 订阅，本轮无法从代码证明。
- 腾讯侧 systemd 单元（有赞同步、普通支付对账）当前启用状态未查（不在本嵌入库内）。
- `user_roles`、`commerce_order_items`、`inv_stock_movements`、`inv_stocks` 缺少对应时间列，**无可靠增量水位**，切换前需靠全量哈希比对而非时间过滤。
