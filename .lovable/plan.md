
# 国内多渠道订单智能导入

复用 meruki 那套「截图 + AI 识别 + 人工维护状态」的成熟模式，扩展到咸鱼、抖音、小红书、微信四个来源。最大差异：国内订单**本币就是 CNY、无国际运费、信息来源更杂**（既有标准订单截图，也有聊天截图）。

## 1. 数据模型

新建独立表 `domestic_orders`（不混入 `japan_parcels`，避免日元/汇率/国际段字段污染）：

| 字段 | 说明 |
|---|---|
| `id` uuid pk |  |
| `platform` text | `xianyu` / `douyin` / `xiaohongshu` / `wechat` |
| `source_order_no` text | 平台订单号；微信聊天截图可空 |
| `seller_name`, `seller_handle` | 卖家昵称 / ID |
| `item_title`, `item_image_url` | 商品 |
| `price_cny`, `shipping_cny`, `total_cny` | 金额 |
| `qty` int default 1 |  |
| `purchased_at` timestamptz | 下单时间 |
| `tracking_no`, `carrier` | 快递单号、承运商 |
| `receiver_name`, `receiver_phone`, `receiver_address` |  |
| `status` text | 见状态字典 |
| `notes` text | 备注 / 议价记录 |
| `chat_summary` text | 微信/咸鱼聊天关键摘要 |
| `raw_payload` jsonb | AI 原始 JSON + 截图 url |
| `screenshot_urls` text[] | 关联截图（存 storage 桶 `domestic-order-screenshots`） |
| `completeness` int | 0-100 |
| `created_at`, `updated_at` |  |

唯一约束：`(platform, source_order_no)`（订单号为空时不去重，由人工合并）。

**状态字典**（5 档，与日本包裹保持一致风格）：
`pending_pay`（待付款/议价中） → `paid`（已付款） → `shipped`（已发货，有快递单号） → `delivered`（已签收） → `completed`（完成入库）。

RLS：登录用户可读写（与现有 `japan_parcels` 一致）。

## 2. Storage

新建 public bucket `domestic-order-screenshots`，路径 `{user_id}/{yyyy-mm}/{uuid}.{ext}`，复用现有 `parcel-item-images` 的 RLS 模式。

## 3. 后端识别管线

新建 `src/lib/domestic-recognize.functions.ts`，调用 Lovable AI Gateway（`google/gemini-2.5-pro` 多模态，识别失败/置信度低自动回退到 `gemini-3-flash-preview` 再试一次）。

```text
[N 张截图] 
   ↓ uploadScreenshots()         上传到 storage，拿 public url
   ↓ classifyPlatform()          先让模型猜平台（也接受用户在 UI 选好）
   ↓ extractOrders(platform, urls)  
                                  prompt 内嵌该平台 few-shot：
                                  - 咸鱼：「我的-已买到」列表 / 订单详情 / 聊天议价
                                  - 抖音：「订单中心」列表 / 详情页
                                  - 小红书：「我的订单」 / 笔记下单
                                  - 微信：聊天截图（卖家发的报价 + 转账记录 + 地址）
                                  返回 OrderDraft[]
   ↓ postProcess()               金额归一（"￥1,200" → 1200）、日期归一、
                                  电话脱敏校验、按 source_order_no 去重
```

每个识别 serverFn 都返回 `{ step, status, ms, data, raw }`，前端用现成的 `RecognizeTimeline` 组件可视化每一步。

微信场景下 prompt 要专门提示：聊天截图里**没有平台订单号**，让模型生成临时号 `wx-{yyyymmdd}-{seller8}-{n}`，并把买家/卖家对话浓缩到 `chat_summary`。

## 4. 前端

```text
/purchase/domestic                列表页（替换现在的 mock）
  ├─ 头部 Tabs：全部 / 闲鱼 / 抖音 / 小红书 / 微信
  ├─ 状态 Tabs（次级）：待付款 / 已付款 / 已发货 / 已签收 / 已完成
  ├─ 搜索 + 刷新按钮
  ├─ 表格：缩略图｜平台徽标｜商品｜卖家｜金额｜快递单号｜状态｜操作
  └─ 顶部按钮「智能导入」→ /purchase/domestic/import

/purchase/domestic/import         导入页
  ├─ 平台选择器（必选，影响 prompt few-shot）
  ├─ ScreenshotDropzone（复用现有组件，支持多图 + 粘贴）
  ├─ RecognizeTimeline（复用）
  ├─ 识别结果可编辑表格（每行可勾选是否入库、可改字段）
  └─ 「批量入库」按钮 → bulkInsertDomesticOrders()

/purchase/domestic/$id            详情/编辑页
  ├─ 截图轮播
  ├─ 字段编辑（与 ParcelEditPanel 同风格）
  ├─ 状态切换按钮（5 档）
  └─ 「打开聊天摘要」抽屉
```

复用组件：`ScreenshotDropzone`、`RecognizeTimeline`、`DataTable`、`StatusBadge`、`PageHeader`、`CompletenessRing`。

## 5. 实施顺序

1. **DB migration**：建表 `domestic_orders` + storage bucket + RLS。
2. **后端 serverFn**：`src/lib/domestic-recognize.functions.ts`、`domestic-orders.functions.ts`（CRUD + list + count）。
3. **导入页** `/purchase/domestic/import`。
4. **列表页**改造 `/purchase/domestic`（删除 mock、接真实数据）。
5. **详情页** `/purchase/domestic/$id`。
6. 把识别经验沉淀到 `.workspace/skills/domestic-order-recognizer/SKILL.md`（参考 meruki skill 的格式）。

## 需要你确认 3 件事

1. **微信订单**：通常是和卖家私聊的截图（议价 + 转账 + 地址），没有标准订单号。我打算让 AI 生成临时号 + 浓缩聊天摘要，可以吗？还是你希望微信单独一个最简表单（连 AI 都不跑）？
2. **状态字典**：上面的 5 档（待付款 / 已付款 / 已发货 / 已签收 / 已完成）够用吗？要不要加「退款中」？
3. 是否需要把**国内订单**也并入「日本包裹合单 / 物流」流程（比如一个包裹里同时有日本竞拍 + 国内闲鱼货品）？还是国内订单完全独立、签收即完成？

确认后我就按上面顺序开搞。
