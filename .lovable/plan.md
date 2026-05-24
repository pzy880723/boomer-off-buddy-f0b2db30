## 背景

`/m/skus` 列表和 SKU 详情手机版 `/m/skus/$id` 已经做好；但 `/m/scan` 扫到 RFID/EPC 命中 SKU 时仍然 `router.navigate` 到 PC 版 `/inventory/skus/$id`，所以手机端点过去就跳到桌面详情页了。

## 改动

**`src/routes/m.scan.tsx`**（第 50 行）
- 将 `router.navigate({ to: "/inventory/skus/$id", params: { id: r.sku.id } })` 改为 `to: "/m/skus/$id"`，其余逻辑保持不变。

## 不在范围
- PC 侧 `product-card.tsx` / `inventory.inbound.$id.tsx` / `inventory.products.$code.tsx` 等桌面入口继续指向 `/inventory/skus/$id`，不动。
- `/m/skus` 列表与 `/m/skus/$id` 详情已就绪，不改。
