# 生产链路只读预检报告 + Canary 方案

只读执行，未改代码、未写数据库、未调用任何有赞写接口、未部署腾讯云。

## 1. 版本与迁移

- commit SHA: `dc0f8438602f9212b5f7edd1159625f8919aa10d`（Work in progress，2026-08-03 16:53 UTC）
- 最新已应用迁移（尾 5）：`20260803173000_vintage_standard_product_catalog.sql`、`20260803144636_*`、`20260803143941_*`、`20260803142151_*`、`20260803115314_*`

## 2. 相关生产路由（均为 TSS file route，`/api/public/*` 绕过站点鉴权，由 handler 自行鉴权）

| 路径 | 鉴权 | 入参 | 出参 | OpenAPI |
| --- | --- | --- | --- | --- |
| POST /api/public/handheld/ai/recognize-item | `authenticateDevice`（X-Device-Token/X-Session-Token） | AiRecognizeReq：image_url / image_base64 / images / image_storage_paths / primary_index / hint | ok+识别结果（category_code、attributes、alternatives） | 已注册 |
| POST /api/public/handheld/ai/prepare-listing-image | 同上 | image_url / image_base64 / instruction | storage_path、signed_url(7d)、mime_type | 已注册 |
| POST /api/public/handheld/items/smart-create | 同上 + 幂等键 | SmartCreateReq（图片、类目、价格、库位、auto_push_youzan） | SKU + 打印载荷 | 已注册 |
| POST /api/public/handheld/items/upload-image、items/sign-read-url、rfid/bind-item、rfid/stock-in | 同上 | — | — | 已注册 |
| GET /api/public/storefront/products、products/{id}、taxonomy、orders、payments | 公开读 / 消费者 token | — | — | 已注册（openapi.ts 共 19 组 path） |
| POST /api/public/hooks/youzan-message | 有赞签名 MD5(client_id+msg+client_secret) 验签 | 有赞消息体 | ok | 未注册 OpenAPI（内部 webhook） |
| POST /api/public/hooks/youzan-sync-worker、youzan-stock-worker、channel-sync-worker、youzan-reconcile 等 | 内部 hook | — | — | 未注册 |

## 3. 数据库对象

- `inv_skus`：`stock_qty`、`status`、`is_display`、`sales_state`、`classification_status`；触发器 `inv_skus_fill_barcode`、`trg_inv_skus_derive_scope`、`trg_inv_skus_updated`
- `inv_stock_movements` → 触发器 `trg_shop_movement_enqueue`：仅当库位 kind='shop' 且有 shop_id 时，把 `balance_after` 写入 `youzan_stock_sync_queue`（`push_stock`，冲突时更新）
- 队列/worker：`youzan_stock_sync_queue`（4 行：done 3 / failed 1）、`channel_sync_outbox`（**0 行**）、`inventory_sale_events`（**0 行**）
- RPC：`commit_sale`、`claim_channel_sync_tasks`、`restore_after_return_inspection`、`inv_apply_movement` 均存在
- 定时器：`cron` schema 无读权限；迁移中仅 `20260704153607` 一处 `cron.schedule`，未见 channel-sync/stock worker 的调度

## 4. Secret（只报状态）

SET：`LOVABLE_API_KEY`、`YOUZAN_CLIENT_ID`、`YOUZAN_CLIENT_SECRET`、`YOUZAN_PROXY_URL`、`YOUZAN_PROXY_TOKEN`、`SUPABASE_SERVICE_ROLE_KEY`、腾讯短信四项
UNSET：`HANDHELD_JWT_SECRET`（当前 handheld 鉴权走数据库 device/session token，不依赖该变量）

## 5. 库位与门店绑定

- active 库位 2 个：`中信泰富店`（shop，已绑 shop_id）、`总部仓库`（warehouse）
- `youzan_shops` 2 行：`BOOMER OFF vintage`（hq，token 已绑，channel 未解析，chain_probe=unknown）；`BOOMER OFF vintage（中信泰富店）`（branch，token 已绑，`sell_channel_id`/`offline_sell_channel_id` 均为空，chain_probe=**failed**）

## 6. 最近队列/日志统计（脱敏）

`youzan_sync_logs` 汇总：items ok 10 / error 36；orders ok 10 / error 13；materials_upload error 14（0 成功）；chain_organization_list ok 9 / error 10；fix_sell_channel ok 2 / error 7；distribution_probe error 6；branch_item_probe error 2；items 有 1 条 `running` 悬挂（2026-07-18 起未收口）。
最近错误样本：`materials_upload` 连续失败（sku_id=c69c…94c，素材上传未通过）；`youzan_stock_sync_queue` 最新失败 `[122001001] 商品不存在!`（2026-08-02）。
smart-create / 图片 / 销售 webhook：**无任何生产记录**（相关表 0 行）。

## 7. 闭环判断

真实可自动执行：
- 手持鉴权、拍照上传、AI 识别（Lovable AI Gateway key 已配）、上架图修整（写入 sku-listing 桶并签名）
- smart-create 建档 + EPC/条码生成 + 标签打印载荷（模板 2 份）
- 门店库位库存变动 → 触发器自动入 `youzan_stock_sync_queue`
- 有赞消息 webhook 代码路径完整（验签 → 映射 → commit_sale）

仅有代码/UI/队列、**未形成生产闭环**：
- 有赞建品与素材上传：materials_upload 0 成功，最近库存推送因「商品不存在」失败 → 分店侧商品并未真正建成
- 分店渠道：branch 的 sell_channel_id / offline_sell_channel_id 为空、chain_probe=failed → 线上+线下双渠道铺货未打通
- 销售回传：`inventory_sale_events` 0 行，`sku_youzan_links` 仅 4 行 → 从未有一笔真实回传把 ERP 库存归零
- storefront 商品：`commerce_listings` 0 行 → BOOMEROFF 市集无在售商品，「售罄下架」链路无数据验证
- `channel_sync_outbox` 0 行且无 cron 调度 → 全渠道 outbox worker 未在生产跑
- 「自动生成达人文案并发布发现且下挂商品」：**不存在生产链路**。`editorial_contents`/`editorial_content_relations` 均 0 行，内容模块无任何 AI 生成调用（AI 只用于商品识别/翻译/包裹解析）

## 8. Canary 测试方案（不污染正式商品）

原则：单件、可识别命名、专用类目兜底、全程可回滚。

1. 准备：新建 1 个 SKU，名称前缀 `ZZ-CANARY-<日期>`，类目用 `ai_low_confidence`，价格取最低档，`is_custom_price=false`，库存 1，库位=中信泰富店。
2. 链路 A（不碰有赞）：手持拍照 → recognize-item → prepare-listing-image → smart-create（`auto_push_youzan=false`）→ 打印标签 → 扫码回查。验收：`inv_skus` 1 行、`inv_stocks`=1、`youzan_stock_sync_queue` 出现 pending。
3. 链路 B（有赞写，需你单独批准）：先修复 branch 的 sell_channel_id / offline_sell_channel_id（chain_probe 必须 ok），再对该 canary SKU 单独执行建品 + 库存推送，观察 `youzan_sync_logs` 是否出现一次真实成功。
4. 链路 C（销售回传）：门店线下卖出这 1 件（或有赞后台手动关闭），验收 `inventory_sale_events` 新增、`inv_skus.sales_state='sold'`、`stock_qty=0`、`is_display` 按策略变更。
5. 清理/回滚：
   - ERP 侧：`inv_skus.status='archived'` + `is_display=false`（forward-only，不物理删）；清掉该 SKU 的 `youzan_stock_sync_queue` pending 行。
   - 有赞侧：把 canary 商品库存置 0 并下架（不删除其它商品）；只操作 spu_code 前缀 `ZZ-CANARY-` 的对象。
   - 全程用 spu_code / 名称前缀做白名单过滤，禁止批量语句。

## 需要你决定

- 是否授权执行链路 B/C（会产生有赞写操作）；本轮预检未执行任何写。
