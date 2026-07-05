## 目标

1. ERP 商品生命周期字段与**有赞连锁零售完全对齐**：`selling` / `sold_out` / `in_warehouse`
2. 已售罄商品补货流：手持机搜到 → 输入补货数量 → 系统提示打印 → 一键写库存 + 生成标签打印批次

## 状态字段：命名 + 存储

对齐有赞（`is_display` + `sold_status`）：

| 状态         | 中文标签 | 存储 `is_display` | 生效条件               |
| ------------ | -------- | ----------------- | ---------------------- |
| `selling`    | 销售中   | `true`            | 上架 + total_qty > 0   |
| `sold_out`   | 已售罄   | `true`            | 上架 + total_qty = 0   |
| `in_warehouse` | 仓库中 | `false`           | 手动下架               |

**存储决定**：ERP 只存布尔 `inv_skus.is_display`（true=上架、false=仓库中），与有赞字段名/语义 1:1。`sold_out` 由服务端派生。API 对外返回 enum `listing_status: 'selling' | 'sold_out' | 'in_warehouse'` + `status_label` 中文。

### Migration

```sql
ALTER TABLE public.inv_skus
  ADD COLUMN is_display boolean NOT NULL DEFAULT true;
CREATE INDEX idx_inv_skus_is_display ON public.inv_skus(is_display);
```

（保留旧 `status`（active/archived）不动，代表"归档/回收"，与"上下架/售罄"正交。）

## 服务端 helper

`src/lib/handheld/listing-status.ts`：

```ts
export type ListingStatus = "selling" | "sold_out" | "in_warehouse";
export function deriveListingStatus(isDisplay: boolean, totalQty: number): ListingStatus {
  if (!isDisplay) return "in_warehouse";
  return totalQty > 0 ? "selling" : "sold_out";
}
export const LISTING_STATUS_LABEL: Record<ListingStatus, string> = {
  selling: "销售中", sold_out: "已售罄", in_warehouse: "仓库中",
};
```

## 三个读接口（补齐字段 + `status` query）

- `GET /handheld/products`、`GET /handheld/global-stock`、`GET /handheld/items/{id}`：
  - SELECT 增加 `is_display`
  - 每个 item 增加 `is_display`、`listing_status`、`status_label`
  - `products` / `global-stock` 新增 query `status = selling | sold_out | in_warehouse | all`（默认 `all`）
  - 非 HQ 门店"仅 qty>0"限制在 `status=sold_out|in_warehouse` 时跳过

## 写接口 A：上下架

**`POST /api/public/handheld/items/{id}/set-status`**
- Body：`{ is_display: boolean }`（严格贴有赞语义；不接受 sold_out——它是派生态）
- 权限：`super_admin | hq_operator | shop_manager`
- 逻辑：
  1. 更新 `inv_skus.is_display`
  2. 若有 `sku_youzan_links`（branch_stock/hq_spu），入队 `youzan_stock_sync_queue` `action='push_is_display'`（新枚举 + 新列 `target_is_display bool`）
  3. 返回 `{ id, is_display, listing_status, status_label, total_stock_qty }`

## 写接口 B：已售罄补货 + 打印

**`POST /api/public/handheld/items/{id}/restock`**（新建）

Body：
```jsonc
{
  "location_id": "uuid",      // 补货入哪个库位（默认设备当前 location）
  "delta": 3,                 // 本次补货数量（>=1）
  "print_labels": true,       // 是否同时生成打印批次（默认 true）
  "label_template_id": "uuid" // 可选，缺省用该 SKU 类目默认模板
}
```

权限：设备已认证 + 该 location 有权限。

逻辑：
1. **写库存**：`inv_apply_movement(sku_id, location_id, +delta, ref_type='handheld_restock')`
2. **重新派生状态**：读最新 total_qty；若之前 `sold_out` 且现在 >0，通知有赞库存已由 trigger `tg_shop_movement_enqueue` 自动入队推送，无需重复
3. **建打印批次**（当 `print_labels=true`）：`insert into inv_label_batches(sku_id, template_id, qty=delta, source='handheld_restock', ...)`，返回 `batch_id`
4. 返回：
```jsonc
{
  "sku": { "id", "listing_status", "status_label", "total_stock_qty" },
  "movement": { "delta", "balance_after", "location_id" },
  "label_batch": { "id", "qty", "template_id", "print_payload" }  // 缺省则 null
}
```

## APP 补货流交互（不落到 ERP 代码，只是接口契约配合）

服务端约定 `items/{id}` 详情增加提示字段：`can_restock: true`（当 listing_status='sold_out' 时前端可弹「补货入库」按钮）。APP 侧交互：

```text
1. 手持机搜索 → 商品详情显示"已售罄" + [补货入库] 按钮
2. 点击 → 弹出补货数量输入 + 选择库位
3. 提交 → POST /restock (print_labels=true)
4. 响应带 label_batch → APP 触发本地打印驱动打印 print_payload × qty
5. Toast：库存 +N，已生成 N 张标签
```

（APP 侧本身的实现不在本 PR，但接口按上面契约提供。）

## 有赞同步

- `sold_out ↔ selling` 库存联动：现有 `tg_shop_movement_enqueue` 已自动入队 `push_stock`，有赞会**自动派生** `sold_status`，无需额外接口
- `in_warehouse` ↔ `selling` 上下架：新增 queue action `push_is_display`
- 有赞对应接口调用（`youzan.retail.product.online` / `offline`）本次先落 queue，实际调用放到下一 PR（现有 `youzan-sync` worker 增加分支）

## OpenAPI snapshot

- 三个 GET 加 `is_display / listing_status / status_label` + 新 query
- 新增 `POST /handheld/items/{id}/set-status`
- 新增 `POST /handheld/items/{id}/restock`

## 前端 ERP 侧影响

- `/shop-mgmt/products` 顶部 Tab：销售中 / 已售罄 / 仓库中 / 全部
- SKU 卡片右上角操作：`上架 / 下架`；卡片状态徽标用中文标签
- `/inventory/skus` 列表：默认不过滤（仓库不体现"售罄"，但仍显示 `is_display=false` 的商品，带"仓库中"角标以便识别）

## 待你确认

1. 补货接口权限：只要设备认证 + 有 location 权限即可？还是要求角色 `shop_operator+`？
2. 补货后**默认自动创建打印批次**（`print_labels=true`），还是**默认不打印**、由 APP 显式勾选？
3. 有赞 online/offline 调用是本次一并做，还是先落 queue，下一 PR 由 worker 消费？
