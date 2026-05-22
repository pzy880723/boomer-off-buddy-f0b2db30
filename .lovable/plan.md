我查到原因了：不是你授权没成功，而是我们代码里换取有赞 access_token 的参数用错了。

现在本地店铺记录里总部没有 token，最近同步日志都是：

```text
有赞换 token 失败：参数错误
```

对照有赞官方文档，自用型应用换 token 应该传：

```json
{
  "client_id": "...",
  "client_secret": "...",
  "authorize_type": "silent",
  "grant_id": "店铺 kdt_id",
  "refresh": "false"
}
```

但当前代码传的是：

```json
{
  "grant_type": "silent",
  "kdt_id": 153242272
}
```

所以有赞一直返回“参数错误”，后面的商品/订单同步自然跑不起来。

实施计划：

1. 修改 `fetchSilentToken`
   - 把 `grant_type` 改为 `authorize_type`
   - 把 `kdt_id` 改为 `grant_id`
   - 增加 `refresh: "false"`
   - 兼容有赞返回的 `code: 200` 成功状态
   - 兼容 `expires` 毫秒时间戳，正确保存过期时间

2. 增强错误提示
   - 如果仍失败，返回有赞原始错误信息，页面能直接看到是“密钥不对 / 店铺未授权 / 权限不足 / 参数问题”中的哪一种。

3. 验证同步链路
   - 修完后先用总部店铺跑一次“测试连接/同步商品”
   - 若 token 成功，再继续商品全量同步和订单最近 30 天同步

这次不用你再去填“登录回调地址”，它不是这个问题的原因。