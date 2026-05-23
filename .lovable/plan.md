## 结论

这次截图里的错误已经不是“微商城接口选错”那一层了，而是**网关路径仍然错了**：当前代码调用的是：

```text
https://open.youzanyun.com/api/oauthentry/youzan.retail.open.spu.query/3.0.0?access_token=...
```

但有赞新网关文档和报错案例显示，零售开放接口应走：

```text
https://open.youzanyun.com/api/youzan.retail.open.spu.query/3.0.0?access_token=...
```

也就是要去掉 `/oauthentry`。否则即使接口名是对的，也会被网关判定为 `[gw 4005] 非法的API`。

## 修正计划

1. **修正有赞 API 网关地址**
   - 把 `YZ_GW_URL` 从 `/api/oauthentry` 改为 `/api`。
   - 保持现有 `POST + JSON body + access_token query` 调用方式。
   - 这样 `youzan.shop.get`、`youzan.retail.open.spu.query`、`youzan.retail.open.online.spu.query`、`youzan.retail.trade.*` 都走同一套官方新网关。

2. **商品同步继续按零售连锁业务分流**
   - 总部：拉总部商品库 `youzan.retail.open.spu.query.3.0.0`。
   - 分店：拉门店在售 `youzan.retail.open.online.spu.query.1.0.0`，用总部 token + 分店 `kdt_id`。
   - 当前这部分业务模型保留，不退回微商城接口。

3. **订单同步保留“总部跳过、分店拉订单”**
   - 总部订单直接 `skipped`。
   - 分店继续尝试 `youzan.retail.trade.order.search`，失败再试 `youzan.retail.trade.search`。
   - 如果修正网关后仍 4005，再说明是应用没有开通对应交易能力包，而不是路径问题。

4. **改善失败信息**
   - 错误信息里追加实际调用的接口路径片段（不暴露 token），方便发给有赞核查。
   - 同步日志里保留 method/version/trace，避免再靠猜。

5. **清理旧 running 记录**
   - 代码已有自动把超过 90 秒的 running 标成失败；修正后再次同步会自动清掉旧假运行状态。

## 验证方式

- 先点总部「同步商品」：如果不再出现 `retail.open.spu.query.3.0.0: [gw 4005] 非法的API`，说明路径修正生效。
- 再点分店「同步订单」：
  - 有数据：完成。
  - 仍 4005：拿日志里的 `method + version + trace` 给有赞，让他们确认自用型应用是否开了零售商品/零售交易能力包。
  - 返回授权关系不存在：说明该分店 `kdt_id` 没被当前自用型应用授权。