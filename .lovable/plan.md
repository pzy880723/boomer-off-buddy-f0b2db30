## 问题

数据库里已有 10 条新 SKU，但 `/inventory/skus` 列表为空。原因：`src/lib/inventory.functions.ts` 中所有 serverFn 都在 handler 内用模块级 `supabase`（匿名 client，没附 Bearer token），而 `inv_skus` 等表的 RLS 策略限定 `to authenticated`，匿名身份被过滤为 0 行。上次只修了 `createStandardSkus`（能写入），其它读/写函数没改（所以读不出来）。

## 改动

只改 `src/lib/inventory.functions.ts`：给下列 serverFn 加 `.middleware([requireSupabaseAuth])`，handler 内 `supabase.from(...)` 改为 `context.supabase.from(...)`。

- 读：`listSkus`、`getSku`、`lookupSkusByEpcs`、`listInboundOrders`、`getInboundOrder`
- 写：`createCustomSku`、`createBundleSku`、`updateSku`、`createLabelBatch`、`submitInbound`

`submitInbound` 里的 `supabaseAdmin.rpc("inv_apply_inbound_stock", ...)` 保留不动（库存累加用 service role 没问题）。

不修改任何 UI、RLS、schema 或 client 文件。
