# 只读核查结果：热门搜索/排行、客服通知、商品原图

当前提交：`7b1adb4aba37d3a3e8f78f0c9154cdaa4c5999b0`（Lovable 内嵌后端，不代表腾讯生产已发布）。本轮未修改代码或数据。

## 1. 热门搜索与热门商品排行
- **没有**真实的搜索词次数/人数榜，也**没有**商品点击打开或收藏人数统计。
- 数据库里只有支付、物流、销售、打印四类事件表，没有搜索、浏览、点击、收藏相关表。
- `src/routes/api/public/storefront/products.ts` 只调用 `search_inv_skus` 返回搜索结果，不记录搜索词。`products.$id.ts` 不记录打开次数。
- 内容收藏/点赞（`src/routes/api/public/content/$id.bookmark.ts`、`$id.like.ts`）只针对文章内容，不针对商品。
- 结论：不能拿现有数据做热门榜，否则就是伪造。

## 2. 小程序客服是否连到 ERP 和安卓工作机
- 创建会话：`src/routes/api/public/storefront/support.conversations.ts` 调用 `ensureCustomerConversation`（`src/server/support.server.ts` 第716行），写入 `support_conversations`，channel=native。顾客消息由 `postCustomerMessage`（第839行）写入 `support_messages`。这些数据会进入 ERP 和手持机的客服列表（`/api/public/handheld/support/conversations`，按门店权限过滤，总部可看全部）。
- 聚合数据：5 个会话（全部 native）、6 条消息。
- **不会**生成手持机通知：support 表上只有更新时间、touch、等待状态三个触发器，代码里也没有写入通知表；`inv_handheld_notifications` 当前共 0 行。
- 安卓获取通知的方式：只能轮询 `GET /api/public/handheld/notifications`（设备+员工双重鉴权；可见范围为本人、本设备、有权限的门店或全局广播；字段包括 kind/ref_type/ref_id）。
- 主动推送（极光/FCM/个推）：设置和代码中都**不存在**。

## 3. 商品原图链接
- 私有桶签名链接有效期为 24 小时（`src/server/media-derivative.server.ts` 第24行、`src/lib/sku-image-resolver.server.ts` 第18行）。`image_urls`/`image_previews` 过期后需要重新请求商品详情来刷新，目前没有单独的“查看原图并刷新”接口。
- `/api/public/media/sku/$` 是公开、不限期的代理，能读取 sku-raw/sku-listing 两个桶的任意文件，等于变相公开私有桶，不建议给小程序使用。
- 腾讯原图：仓库里有腾讯存储切换路径，但实际开关和地域无法从这里核实。

## 最小修改建议（需另行批准）
1. 新增 `storefront_search_events`、`storefront_product_events`（open/favorite）表，记录匿名或顾客 ID，仅服务端可写；做每日聚合 RPC，并新增 `GET /storefront/search/hot`、`/products/hot`。商品收藏需要单独一张收藏表。
2. 在 `ensureCustomerConversation`/`postCustomerMessage` 成功后，写入 `inv_handheld_notifications`（kind=`support_message`，location_id=会话门店，ref_type=`support_conversation`），手持机继续轮询。主动推送需要另外接入厂商并配置密钥。
3. 新增需要鉴权的 `GET /storefront/products/:id/original-image?index=` 接口，在核验商品已上架后返回短期签名原图链接；同时把公开的 sku 代理限制为只能访问已上架商品的图片。
