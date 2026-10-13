# 安卓拍照上架卡住：只读诊断结论（无改动）

## 结论
本项目内嵌数据库从 2026-10-11 起就不再收到任何手持写入，最近的上架图片任务停在 2026-10-07，因此不能把它当现网数据源。卡住问题需要在腾讯线上库和 Android 上传链路排查。

## 只读证据（截至 2026-10-13，均为 UTC 时间）
- inv_listing_image_jobs：succeeded 165 条（最新创建 10-07 06:44）；permanent_failed 1 条（10-07，image_generation 超时）；没有 queued/processing。
- inv_product_content_image_jobs：0 条。
- handheld_smart_create_ops：77 条，最新 10-07 06:43。
- handheld_item_ops：28 条，最新 10-11 11:44。
- inv_skus：自定义 SKU 94 条，最新创建 10-07 06:43，最新更新 10-11 11:44。
- Storage 最新写入：sku-raw 10-07 10:45；sku-listing 10-08 17:25；parcel-item-images 09-04。
- inv_handheld_devices 最近心跳 10-11 06:04；inv_stock_movements 最新 10-10；commerce_orders 仅 4 条，最新 09-23。
- 当前代码版本：1815a027（10-11 07:43）。

## 建议下一步（仅在你批准后，由 Codex 在腾讯侧执行）
1. 在腾讯线上库运行同样的只读汇总，查看 inv_listing_image_jobs、handheld_smart_create_ops 和 Storage 有没有今天的记录。
2. 有 queued/processing 但不推进：检查 boomer-listing-image 定时任务和 HANDHELD_LISTING_IMAGE_WORKER_ENABLED 开关。没有任何记录：检查原图上传接口 items.upload-image 和 smart-create 请求是否到达。
3. 本项目不迁移数据、不批量重试、不改代码。
