# 旧存储域名 `sxddfcoiaboqcmeviykl.supabase.co` 残留媒体链接 · 只读核查

只读执行。未编辑源码、未改数据库、未生成或执行迁移、未发布、未发起有赞同步。不返回隐私数据、签名 URL 或密钥。

## 1. 该域名确属本项目历史媒体来源

`.env` 中 `SUPABASE_URL=https://sxddfcoiaboqcmeviykl.supabase.co`，即本项目当前内嵌数据库/存储的域名。`parcel-item-images` 桶 `public=true`，所以历史上直接把 `/storage/v1/object/public/parcel-item-images/...` 的绝对 URL 落库是可行且被采用的做法。你给的 `test2`（`ee2e611e-…`）就是这一类：`image_paths={}`，`image_url` 为该桶的公开绝对地址。

桶可见性（只读确认）：

| 桶 | public |
|---|---|
| `parcel-item-images` | **true** |
| `sku-raw` / `sku-listing` / `shop-images` / `domestic-order-screenshots` / `domestic-bulk-attachments` / `database_export_09_09_26` | false |

只有 public 桶的绝对 URL 会以裸链形式长期留在数据里；私桶一律存 `bucket/path` 相对引用，运行时签名，因此不含域名。

## 2. 按表/字段的残留计数（全库扫描 22 个媒体类字段）

| 表.字段 | 命中旧域名行数 | 说明 |
|---|---|---|
| `japan_parcel_items.item_image_url` | **1,090** | 最大来源，日本小包裹子订单商品图 |
| `inv_skus.image_url` | **67** | 全部为 `/object/public/parcel-item-images/`，0 条签名 URL |
| `inv_skus.image_paths`（数组元素） | **65 个元素** | 数组里混进了完整旧 URL，而非 `bucket/path` |
| `commerce_order_items.image_snapshot` | **1** | 下单时的图片快照，属历史订单凭证 |
| 其余 18 个字段（`commerce_listings.cover_url/image_urls/image_paths`、`commerce_customers.avatar_url`、`domestic_orders.item_image_url/screenshot_urls`、`domestic_bulk_orders.attachment_urls`、`japan_parcel_items.arrival_photo_urls`、`japan_parcels.item_image_url`、`inv_brands.logo_url`、`editorial_contents.cover_url/video_url`、`official_knowledge_entries.cover_url`、`youzan_items.pic_url`、`youzan_orders.first_item_image`、`youzan_shops.image_url`、`store_offline_sales_entries.evidence_url`、`commerce_after_sales.evidence_urls`、`inv_sku_classifications.evidence`、`meruki_raw_captures.source_url`） | **0** | 干净 |

`inv_skus` 结构分布（528 行）：`image_url` 为空 461 行、非空 67 行且**全部**是旧域名（其它域名 0 条）；`image_paths` 非空 525 行，其中元素 466 个是正常的 `sku-listing/...` 相对路径，65 个是旧域名绝对 URL。67 行里 65 行同时有 paths、2 行只有 `image_url`。

### 来源规则（可据此判断哪些必须改写）

1. **公开桶绝对 URL**（`.../object/public/<bucket>/<path>`）：只在 `parcel-item-images` 出现，是硬编码域名，Lovable 关停即失效 → **必须改写**。
2. **私桶相对引用**（`sku-listing/...` 等）：不含域名，切换到腾讯后由新实例签名，**无需改写**。
3. **签名 URL 落库**：全库 `inv_skus.image_url` 中 0 条，无此历史包袱。

## 3. `sku-image-resolver.server.ts` 确实是旧地址被保留的原因

- `signSkuImagePaths`（`src/lib/sku-image-resolver.server.ts:31-34`）：遇到 `^https?://` 直接 `out[idx] = s` 原样返回，不做任何域名判断——所以混在 `image_paths` 里的那 65 个旧 URL 会原封不动送到前端。
- `signSkuCover`（同文件 71-78 行）：`image_paths` 签不出结果时，回退 `fallbackImageUrl`，条件只有"是 http 且不含 `token=`"——旧公开 URL 正好满足，于是 67 行的 `image_url` 全部照原样输出。
- `signSkuThumbnailPaths`（100-106 行）：对 http 值直接跳过，返回 null，调用方回退原图 → 仍是旧域名。
- `src/lib/sku-media.ts:47-51` 的 `buildPublicSkuMediaUrl` 同样对 http 外链原样返回（只挡带 `token=` 的）。

结论：**不是缓存、不是前端问题，是数据里存了绝对 URL + 解析层对 http 外链一律透传**。两处都要动才彻底。

## 4. 建议（仅建议，不实施）

1. **数据侧改写**（腾讯候选副本上做，一次性）：把 `inv_skus.image_url`、`inv_skus.image_paths` 元素、`japan_parcel_items.item_image_url` 中 `https://sxddfcoiaboqcmeviykl.supabase.co/storage/v1/object/public/` 前缀替换为腾讯实例的同路径前缀；对象已确认在腾讯恢复库存在（35134 bytes, image/webp），路径不变即可命中。
2. **更优做法**：把 `image_paths` 里那 65 个绝对 URL 归一成 `parcel-item-images/<path>` 相对引用，交给解析层统一处理，从此不再有域名硬编码。`image_url` 也可同样归一，但要先确认所有读取方都能吃相对引用。
3. **`commerce_order_items.image_snapshot` 那 1 条**是历史订单快照，属凭证性质，建议只改写域名、不改结构，保留可追溯性。
4. **代码侧加固**（防复发）：在 `signSkuImagePaths` / `signSkuCover` 的 http 分支加一个"已知旧域名"判断——命中则解析出桶和路径按私桶/公桶重新生成当前实例地址，而不是透传。同时把 `sku-media.ts:39` 硬编码的 `boomer-off-buddy.lovable.app` 兜底 origin 一并换掉。
5. **验收**：改写后按上表逐字段重跑同样的计数查询，四个非零字段应全部归零；再用原账号页面复验 `test2` 图片实际请求域名。

## 5. 未改动声明

未编辑任何源码或数据、未生成或执行迁移、未批准此前任何计划、未发起有赞同步、未发布、未触碰腾讯生产。
