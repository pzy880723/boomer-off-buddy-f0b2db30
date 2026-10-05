# 只读排查结论：SKU 5bf7c0b9（花小兔收纳盒）商品卡预览/图片不显示

本轮只读，没有改代码、数据库，也没有部署。

## 数据证据（非敏感）
- 商品状态 active，sku_scope=custom，image_processing_status=succeeded。
- `image_url` 为空（NULL），不是过期签名的外链。
- `image_paths` 只有 1 条：`sku-listing/gallery/<sku>/<uuid>/<uuid>.png`，路径格式合法。
- 存储对象确实存在：sku-listing 桶，image/png，约 1.31 MB（1,306,838 字节）。
- 品牌=三丽鸥 (Sanrio)，IP=Usahana，都已确认。关键词 5 个。
- 上架名：`绝版！Usahana花小兔粉色卡通文具盒收纳盒`，开头带"绝版！"。
- 已发布正文：1 家门店 published，正文 18 字。

## 两个接口取图方式不同
- **商品详情 image_url**（`src/server/handheld-products.server.ts` `signProductItems`）：路径能被 `parseSkuMediaPath` 识别时，不签名，返回公开代理地址 `{PUBLIC_APP_ORIGIN}/api/public/media/sku/sku-listing/...?width=480`（大图用 width=1600）。代理在 `src/routes/api/public/media/sku/$.ts`，由服务端读图并缩放成 JPEG。没有过期问题，但要求腾讯配置的 PUBLIC_APP_ORIGIN 指向能访问的站点。
- **商品卡 image.read_url**（`items.$id.recommendation-card.ts` → `signSkuImagePaths`，`src/lib/sku-image-resolver.server.ts`）：用 service-role `createSignedUrls` 给存储直链签名，有效 24 小时。返回的是 **1.31 MB 原图 PNG**，不缩放；地址是存储域名，不是代理域名。
- 只有签名失败时 read_url 才会是 null、status 才会是 missing。本次路径和对象都有效，按代码推断应为 ready（腾讯响应体本轮看不到，未核实）。

## 可能原因（按可能性排序）
1. **原生端加载问题**：商品卡给的是存储直链和 1.3 MB 原图 PNG，详情给的是代理地址和 480 宽 JPEG。iOS 预览如果对存储域名有访问限制（ATS 或网络白名单）、做大图解码或抠图，或者错误地沿用了详情的 image_url 逻辑，就会出现"详情有图、卡片无图"。请 Codex 在原生端检查 `card.image.status` 和 read_url 的域名能否访问。
2. **AI 被拒导致整卡判失败**：上架名带"绝版！"，正好是禁用词，AI 一旦沿用就会报 `ai_unsupported_claim`。另外 card_title、headline 长度上限收紧了，`ai_invalid_output` 的概率也上升了。新 iOS 会拒收 source=product 的成品，表现可能就是"预览不显示"。英文词这块风险低：Usahana、Sanrio 都在名称或已确认品牌/IP 里，可以放行。
3. 腾讯 Tencent 的 fallback_reason 只写在 `recommendation_card_ai_fallback` 日志里，只含原因码和状态码，本轮拿不到。

## 建议下一步（需你授权，本轮不执行）
- Codex 查腾讯 15:15:54 那次响应的 `source`、`fallback_reason`、`image.status`，以及 `recommendation_card_ai_fallback` 日志的原因码。
- 如果确认是第 1 条：把商品卡 read_url 改成和详情一致的代理地址（width=1600），或者给签名加缩放参数。只改推荐卡这一处路径。
- 如果确认是第 2 条：在发给 AI 前，把上架名里的禁用词（绝版/限量等）去掉，只当素材用，不改商品本身。
