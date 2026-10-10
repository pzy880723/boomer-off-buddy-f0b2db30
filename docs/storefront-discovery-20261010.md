# 小程序热门发现接口（Lovable 代码/迁移状态，未发布腾讯）

迁移：`drizzle/migrations/0048_storefront_engagement.sql`（回滚语句见文件头）。
覆盖范围：第一版只统计已验证登录顾客；匿名顾客可正常浏览，不记录、不强制登录。

以下样例为 **mock**（字段真实，数值示意）：

```json
// POST /api/public/storefront/engagement   Authorization: Bearer <顾客令牌>
{"kind":"open","product_id":"<listing uuid>"}
-> {"ok":true,"data":{"recorded":true,"reason":null}}          // 同顾客同商品同日再次: recorded:false, reason:"already_counted_today"
{"kind":"favorite","product_id":"<listing uuid>","selected":true}
-> {"ok":true,"data":{"recorded":true,"active":true}}          // 重复收藏 recorded:false；selected:false 取消
{"kind":"search","query":"Noritake"}
-> {"ok":true,"data":{"recorded":true}}                         // 非词表词: {"recorded":false,"reason":"not_in_vocabulary"}
// 错误: 401 未登录, 400 validation_error(含 user_id 等多余字段), 404 product_unavailable, 429 rate_limited(每顾客每日500次)

// GET /api/public/storefront/discovery
-> {"ok":true,"data":{"source":"preset","terms":[],"window_days":30}}   // 当前真实返回
-> {"ok":true,"data":{"source":"actual","terms":[{"key":"brand:<id>","label":"Noritake","query":"Noritake"}],"window_days":30}}

// GET /api/public/storefront/products?sort=popular&page=1&page_size=20  (保留 q/category/brand_ids/facet_codes/location_id/fankuang)
// 每个商品新增 view_count(近30天打开人数) / favorite_count(当前有效收藏人数)；详情 /products/:id 同样返回。
```
