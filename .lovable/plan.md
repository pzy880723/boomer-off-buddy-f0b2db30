## 仪表盘统计口径改为"商品支付时间"

### 现状问题
`getPurchaseStats` 现在用 `purchased_at || created_at` 兜底，相当于按入库时间统计。真实支付时间在：
- **日本小包裹**：`japan_parcel_items.pay_at`（148/148 全有），金额用 `item_total_cny`。`japan_parcels.purchased_at` 实际全空，不能用。
- **国内小包**：`domestic_orders.purchased_at`，金额用 `total_cny`。

### 改动（只动 `src/lib/dashboard.functions.ts`）

1. **日本小包裹**：改成查 `japan_parcel_items`，join 父表过滤 `deleted_at`。
   ```sql
   select pay_at, item_total_cny from japan_parcel_items i
   join japan_parcels p on p.id=i.parent_id
   where p.deleted_at is null and i.pay_at is not null
   ```
   - 单数 `count`：保留按父包裹 distinct 计（口径仍是"采购了 N 单"）。
   - 月/年/累计金额：按 `pay_at` 落到对应区间，按 `item_total_cny` 累加。
   - 12 月趋势同样以 item.pay_at 为 bucket。
   
2. **国内小包**：去掉 `created_at` 兜底，只用 `purchased_at`。无 `purchased_at` 的订单不计入统计（之后这些订单补上支付时间后会自动出现）。

3. **日本大宗**：维持 0 + `placeholder: true`。

4. UI 不动；如需提示"未设置支付时间的订单不计入"，在国内小包 Card 加一行小字（可选，本次先不做）。

### 不动
日本大宗占位、卡片布局、趋势图组件、其他模块。
