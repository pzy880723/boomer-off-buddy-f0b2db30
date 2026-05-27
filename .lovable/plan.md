## 问题
手机端 `ItemDetailSheet` 计算拆包单价时直接用 `item.item_total_cny`，没有像 PC 端那样按重量分摊国际运费、再加关税。`PackPriceCalculatorDialog` 也因此收到错误的 `landedCny`，保存的整体成本和单价都偏低。

PC 端的正确做法在 `item-card-dialog.tsx`：调用 `computeParcelItemLanded({ intl_total_jpy, intl_exchange_rate }, siblings)`，取该商品的 `landed.landedCny`，再传给 `computePiecePrice` / `PackPriceCalculatorDialog`。

`pack_pieces / pack_pieces_source / pack_unit_note` 三个字段本来就是 `japan_parcel_items` 表里的，PC 与手机写的是同一行（通过 `updateParcelItem`），无需新建字段。

## 改动

### 1. `src/lib/mobile.functions.ts`
新增 server fn `getParcelLandedContext`：
- 入参：`{ parcel_id: string }`
- 查 `japan_parcels` 取 `intl_total_jpy, intl_exchange_rate`
- 查 `japan_parcel_items` 取该 parent 下所有商品的 `id, item_total_jpy, unit_price_jpy, quantity, weight_g, tariff_rate`
- 返回 `{ parcel, items }`，给前端 `computeParcelItemLanded` 用

### 2. `src/components/mobile/item-detail-sheet.tsx`
- 引入 `computeParcelItemLanded` 和新 server fn。
- 当 `item.parent_id` 存在时，`useQuery(["mobile-parcel-landed", parent_id])` 拉 context（`enabled: open && !!parent_id`，`staleTime: 60s`）。
- 用 `computeParcelItemLanded(parcel, items).get(item.id)` 得到 `landed`。
- 拆包卡片：`computePiecePrice(item.item_total_jpy, landed.landedCny, pp)`。
- 在金额块新增一行「到手价 / 运费分摊 / 关税」简版显示（与 PC 端口径一致），方便核对。
- `<PackPriceCalculatorDialog landedCny={landed?.landedCny ?? null} />`（替换原来错误的 `item.item_total_cny`）。
- 关闭对话框时除了 `mobile-parcel`/`mobile-parcels`，再 invalidate `["mobile-parcel-landed", parent_id]`，确保 landed 也刷新（其实 landed context 与 pack_pieces 无关，但保险）。

### 3. 不变
- `PackPriceCalculatorDialog`、`updateParcelItem`、`computeParcelItemLanded`、数据库 schema、RLS、PC 端 UI。
- `mobile.functions.ts` 已有的 `searchParcels` 字段保持不变（按重量分摊需要 siblings，单条 item 查询里塞不下，所以单独发一次轻量查询是更干净的做法）。

## 技术细节
```ts
// mobile.functions.ts
export const getParcelLandedContext = createServerFn({ method: "GET" })
  .inputValidator((i: unknown) => z.object({ parcel_id: z.string().uuid() }).parse(i))
  .handler(async ({ data }) => {
    const [p, it] = await Promise.all([
      supabaseAdmin.from("japan_parcels")
        .select("id, intl_total_jpy, intl_exchange_rate")
        .eq("id", data.parcel_id).maybeSingle(),
      supabaseAdmin.from("japan_parcel_items")
        .select("id, item_total_jpy, unit_price_jpy, quantity, weight_g, tariff_rate")
        .eq("parent_id", data.parcel_id),
    ]);
    if (p.error) throw new Error(p.error.message);
    if (it.error) throw new Error(it.error.message);
    return {
      parcel: { intl_total_jpy: p.data?.intl_total_jpy ?? null, intl_exchange_rate: p.data?.intl_exchange_rate ?? null },
      items: it.data ?? [],
    };
  });
```
