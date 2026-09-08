# 门店清单只读核查结果 + 最小门店接口建议

未改任何代码、未迁移、未发布。腾讯线上 3ca4497 不受影响。

## 1. 门店数据现状（真实表）

权威表是 `youzan_shops`（门店主档）+ `inv_locations`（商品/库存所挂的 location，`kind='shop'`，通过 `shop_id` 一一对应）。

现有可用字段：

| 需求字段 | 真实字段 | 现状 |
| --- | --- | --- |
| 门店 id（商品筛选用） | `inv_locations.id` | 4 家门店 location 全有 |
| 门店 id（主档） | `youzan_shops.id` / `kdt_id` | 全有 |
| name | `youzan_shops.shop_name` / `inv_locations.name` | 全有 |
| city | 无独立字段 | 缺，只能从 address 文本推断 |
| address | `youzan_shops.address` | 4 家中 2 家有 |
| 门头照片 | `youzan_shops.image_url`（私有桶 `shop-images` 的对象路径，非 URL） | 仅 1 家有 |
| 营业时间 | 无字段 | 完全缺失 |
| latitude / longitude | 无字段 | 完全缺失 |
| 其他 | `manager`、`phone`、`area_sqm`、`opened_at`、`ownership`、`status`、`store_format` | phone/manager 属联系人信息，不宜对外 |

门店实况（非敏感）：

- BOOMER OFF vintage — status active，但对应 location `is_active=false`，有 address，无门头图，上架商品 0
- BOOMER OFF vintage（中信泰富店）— active，有 address，有门头图，已发布商品 4
- 新天地店 — active，无 address，无门头图，上架 0
- 温州朔门古港店 — active，无 address、无门头图，上架 0
- 另有「总部仓库」location（`kind` 非门店/无 shop 主档语义），不应出现在对客门店列表

结论：目前只有 1 家门店具备完整对客展示素材；“定位最近优先”所需经纬度在库里根本不存在，必须先补数据。

## 2. 已有公开接口

`src/routes/api/public/` 下没有任何门店清单接口（`youzan_shops` 未在任何 public 路由中被读取）。

商品接口已支持按门店筛选：

- `GET /api/public/storefront/products`
  - `parseStorefrontProductQuery`（`src/server/storefront-products.server.ts:178`）已解析 `location_id`
  - `src/routes/api/public/storefront/products.ts:54`：`if (query.location_id) db = db.eq("location_id", query.location_id)`
  - 传的是 `inv_locations.id`，不是 `youzan_shops.id`
  - 响应：`{ ok, data: [...], pagination: { page, page_size, total }, filters }`，每条商品含 `location: { id, name, kind }`
- `GET /api/public/storefront/products/:id` 同样返回 `location`

所以底部弹窗选门店后按门店筛商品，后端已经可用，前端只需带上 `location_id`；“最近优先”后端无支持。

## 3. 最小只读门店接口建议（先不实施）

`GET /api/public/storefront/shops`

```json
{
  "ok": true,
  "data": [
    {
      "id": "<inv_locations.id 用于商品筛选>",
      "shop_id": "<youzan_shops.id>",
      "name": "BOOMER OFF vintage（中信泰富店）",
      "city": null,
      "address": "…",
      "image_url": "<短期签名后的门头图，或 null>",
      "business_hours": null,
      "latitude": null,
      "longitude": null,
      "product_count": 4
    }
  ]
}
```

要点：
- 只返回 `youzan_shops.status='active'` 且对应 `inv_locations.is_active=true`、`kind='shop'` 的门店，排除仓库
- 不返回 `phone`、`manager`、token 等任何敏感字段
- 门头图走短期签名，私桶保持不公开；无图返回 null
- `city`/`business_hours`/`latitude`/`longitude` 先按 null 占位，保持契约稳定

## 4. 需要补的数据（实施前置）

要做“定位最近优先 + 门头图 + 营业时间”，需要一次向后兼容的加列迁移：`city`、`business_hours`(jsonb 或 text)、`latitude`、`longitude`，并由后台补齐 3 家缺 address/图片的门店资料。这属于后续任务，本轮不做。

## 5. 边界

不覆盖普通微信支付与图片性能改动；本计划不含任何迁移或发布动作。
