# 只读核查结论：翻筐乐复用透明抠图（listing cfab8314 / sku 6b80ec84）

结论：这件商品没有透明背景版本。上架修图只把背景换成浅灰底，没有抠图。

## 实际数据（已脱敏，没有签名链接）
- inv_skus.image_paths（2 张，修图状态 succeeded，任务完成于 2026-10-04）：
  - sku-listing/gallery/6b80ec84-…/5de49fc1-…/2e8985e1-….png（原图 sku-raw/2026-10-04/fdcfb9d6-…/519e0fbd-….jpg）
  - sku-listing/gallery/6b80ec84-…/bb40fdee-…/33b93580-….png（原图 sku-raw/2026-10-04/fdcfb9d6-…/0f657072-….jpg）
- 存储里这个 SKU 只有上面两个对象（image/png，约 1.17MB 和 1.31MB），没有 cutout、mask 或透明版本。
- inv_skus 只有 image_url、image_paths、image_processing_status、image_processing_updated_at 这几个图片相关字段，没有任何抠图或 mask 字段。

## 透明度实测（逐像素检查，不靠后缀判断）
- 两张图都是真 PNG，但 colorType=2（RGB，没有透明通道），尺寸 1024×1024。
- 透明像素和半透明像素都是 0 / 1048576。
- 四角像素：215,216,215 和 201,210,212 一带，属于浅灰底，alpha 都是 255。
- 所以腾讯那边的灰底 JPG 和原始数据一致，不是转换时丢了透明度。

## 修图流程追踪
- src/server/handheld-ai.server.ts：SYSTEM_LISTING_IMAGE 提示词明确要求「背景统一为干净浅灰底」，使用 gemini-3.1-flash-image 生成 1:1 图片，不会输出透明背景。检测到尺子时只补边成正方形（preserved_original），同样不透明。
- 调用方：src/server/handheld-listing-image-jobs.server.ts（prepareImage → sku-listing/gallery 或 content 目录）、src/routes/api/public/handheld/ai.prepare-listing-image.ts。
- 衍生图：src/lib/media-derivative.ts + src/server/media-derivative.server.ts，只做缩放，不处理透明度。

## 推荐复用接口（目前不存在，需要另外授权才能做）
- 现在没有可以直接复用的透明抠图接口。如果翻筐乐需要透明图，建议新增一个独立的「抠图」任务：以 sku-raw 原图为输入，输出 PNG 或 WebP（带 alpha）到单独路径，例如 sku-listing/cutout/<sku>/…；先校验 alpha 再落库，不覆盖现有灰底主图，也不影响有赞上架图。
- 另一种做法：在客户端用灰底图做近似去底。效果不可靠，不建议当作真正的抠图结果。

本轮没有改动代码、数据库、库存或订单，也没有部署。
