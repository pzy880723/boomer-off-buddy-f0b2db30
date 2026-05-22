我确认后端和门店数据都在，真正问题不是“门店丢了”，而是同步接口请求/解析不够贴合有赞真实返回：最近同步日志显示 2 家门店都成功换到了 token，但商品接口全部返回 0，订单接口也返回 0，数据库里 `youzan_items=0`、`youzan_orders=0`。

执行方案：

1. 重写有赞商品同步请求参数
   - `youzan.item.common.search.1.0.0` 补齐有赞公开文档里连锁/商品库场景需要的 `kdt_ids` 和 `item_type` 参数，而不是只传分页。
   - 保留 `youzan.items.onsale.get.3.0.0`、`youzan.items.inventory.get.3.0.0` 兜底，但优化 page_size、分页和返回结构解析。
   - 新增对 `youzan.item.search.3.0.0` 或同类列表接口的备用尝试，覆盖“销售中/售罄/仓库中”商品状态场景。

2. 增强商品字段解析
   - 兼容 `items`、`goods_list`、`item_list`、`data.items`、`response.items` 等结构。
   - 同时识别 `item_id / itemId / num_iid / alias / goods_id`、`title / item_title / name`、`price / goods_price / min_price`、库存字段等。
   - 如果列表接口只返回基础字段，再按 `youzan.item.base.get.1.0.0` 对单个商品补详情，避免“列表有 ID 但入库被过滤”。

3. 修正订单同步策略
   - 订单同步不只查 `start_update/end_update`，增加 `start_created/end_created` 作为首次同步兜底，避免店铺近 30 天订单没有“更新时间”导致 0。
   - 增加订单接口版本备选：优先稳定版本，再尝试可用新版。
   - 兼容有赞订单返回里的 `full_order_info_list`、`full_order_info`、`orders`、`trades`、`trade_list` 等真实结构。

4. 修复门店商品页读取边界
   - `stock-transfer.functions.ts` 现在仍在用普通客户端读 `youzan_items`，这会被权限策略拦住；改成服务端可信读取，和 `/youzan` 页面保持一致。
   - 这样即使商品已经入库，`/shop-mgmt/products` 也能正常显示。

5. 同步日志改成“失败就失败”
   - 当前商品同步 0 条也写 `ok`，这会误导；改成 `empty`/明确消息，展示每个接口传了什么关键参数、返回多少、解析多少、入库多少。
   - 同步按钮 toast 直接显示每家店的失败原因，不再只显示“成功 0”。

6. 验证
   - 重新跑一次 2 家门店的商品 + 订单同步。
   - 读取数据库确认 `youzan_items` 或 `youzan_orders` 数量变化；如果有赞接口依然真实返回 0，就把日志里 trace/message 暴露在页面上，能直接拿去对有赞后台查权限/店铺类型，而不是继续盲改。

技术点：
- 修改集中在 `src/lib/youzan.functions.ts`、`src/lib/stock-transfer.functions.ts`、必要时少量调整 `/youzan` 日志展示。
- 不改数据库结构，不动已有门店数据，不删除任何 token。
- 不再创建新页面或大改 UI，只修同步链路和读取链路。