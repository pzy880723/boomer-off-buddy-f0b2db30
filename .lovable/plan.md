## 结论

截图里的订单没同步，不是日期问题，主要原因是现在代码调用了两个零售订单接口：

- `youzan.retail.trade.order.search.1.0.0`
- `youzan.retail.trade.search.1.0.0`

这两个都返回 `[gw 4005] 非法的API`，说明当前有赞应用没有这些接口权限/接口不可用，所以本地 `youzan_orders` 没有拿到订单。

有赞公开资料里更通用的订单列表接口是 `youzan.trades.sold.get`，并且支持用 `offline_id` 按门店筛选订单。所以应该把订单同步从当前非法的 retail 接口，切到通用交易订单接口。

## 调整方案

1. **替换订单查询接口**
   - 优先调用 `youzan.trades.sold.get.4.0.2`
   - 兜底尝试 `youzan.trades.sold.get.4.0.0`
   - 参数使用：
     - `start_update` / `end_update`：按更新时间同步
     - `page_no` / `page_size`
     - `offline_id`：传当前门店的 `kdt_id`，用于筛选该门店订单

2. **保留原 retail 接口作为最后兜底**
   - 如果通用接口也不可用，再尝试现有两个 retail 接口
   - 这样不会丢掉未来已开通 retail 权限后的兼容性

3. **增强订单结构解析**
   - 兼容 `full_order_info_list`、`full_order_info`、`order_info`、`trade` 等不同返回结构
   - 订单号优先取 `tid`
   - 金额取 `payment` / `total_fee`
   - 时间取 `pay_time` / `created` / `update_time`
   - 原始返回继续写入 `raw`，方便后续排查

4. **同步弹窗文案调整**
   - 商品同步文案改成“总部商品库；分店沿用总部商品”
   - 订单同步失败时，把“接口未开通/非法 API”的提示说清楚，不让用户误以为是没订单

## 预期结果

- 门店订单同步不再卡在当前两个非法 retail API。
- 如果 `youzan.trades.sold.get` 已在有赞应用里开通，就能开始入库订单。
- 如果该接口也返回 4005，页面会明确提示：需要在有赞云应用里开通“交易/订单查询”相关能力包。