## 修正计划

1. **侧边栏位置调整**
   - 把「订单管理」移动到「仓库管理」下面、「门店管理」上面。
   - 保持子菜单不变：门店订单、铺货订单、批发订单。

2. **重做商品同步接口策略**
   - 不再只依赖当前的 `youzan.items.onsale.get` / `youzan.items.inventory.get`。
   - 按有赞公开文档补上商品列表查询接口：优先使用 `youzan.item.common.search.1.0.0` 拉商品列表。
   - 对列表返回的商品，再按需调用你提供的 `youzan.item.base.get.1.0.0` 补全基础信息：`item_id / title / display / sold_status / media.images / channel_item_id / root_kdt_id / kdt_id`。
   - 同步入库时继续写 `youzan_items`，并兼容有赞返回的多种字段命名：`item_id`、`channel_item_id`、`title`、`origin_price`、`price`、`media.images[0].url`、`display`、`sold_status`。
   - 同步日志里区分：接口返回数量、解析数量、成功入库数量、失败原因。

3. **修复连锁/门店场景商品拉取**
   - 对每个本地 active 门店分别用自己的 `kdt_id` 换 token 后同步。
   - 总部和分店都同步，但分店商品不再假设可以用总部旧商品接口拿到。
   - 如果某个门店接口权限不支持，会把有赞原始错误写入同步明细，而不是显示“同步 0 条”误导。

4. **订单同步排查与增强**
   - 保留 `youzan.trades.sold.get.4.0.0`，但检查参数和返回结构，兼容 `trades`、`full_trades.trades`、`trade_list` 等结构。
   - 每家门店单独同步近 30 天订单，记录接口返回数量和成功入库数量。
   - 如果订单仍为 0，日志明确显示是“有赞接口返回 0”还是“解析/入库失败”。

5. **修复页面数据函数结构**
   - 把 `/orders/shops` 里内联的 `createServerFn` 挪到 `src/lib/youzan.functions.ts`，路由只负责展示，避免服务端函数和页面逻辑混写导致运行不稳定。

6. **验证**
   - 修复后触发一次「一键同步全部」。
   - 检查 `youzan_sync_logs`、`youzan_items`、`youzan_orders` 三处数据。
   - 如果有赞返回权限/参数错误，直接在页面同步明细里展示真实错误，方便继续对照文档修正。