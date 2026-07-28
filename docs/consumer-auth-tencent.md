# 消费者账号与 ERP 对接

消费者账号与 ERP 员工账号完全独立。

## 边界

- 腾讯云消费者身份服务负责手机号验证码、微信授权、账号合并、Access Token 与
  Refresh Token。
- Flutter APP 只持有短期 Access Token 和轮换 Refresh Token，不持有短信、微信
  AppSecret 或 JWT 私钥。
- ERP 不发送消费者短信，也不调用微信登录接口。ERP 只通过 JWKS 验证 RS256 JWT，
  再把 JWT 的 `sub` 映射到 `commerce_customers`。
- ERP 员工继续使用原有 Supabase/Handheld 登录，两套账号不可互换。

## ERP 环境变量

```text
CONSUMER_AUTH_ISSUER=https://admin.boomeroff.top
CONSUMER_AUTH_AUDIENCE=boomer-off-storefront
CONSUMER_AUTH_JWKS_URL=https://admin.boomeroff.top/.well-known/jwks.json
```

## JWT 必要字段

```json
{
  "iss": "https://admin.boomeroff.top",
  "aud": "boomer-off-storefront",
  "sub": "<腾讯云消费者稳定 UUID>",
  "exp": 1785000000,
  "phone": "13800001111",
  "wechat_openid": "<optional>",
  "wechat_unionid": "<optional>",
  "providers": ["phone", "wechat"]
}
```

`phone`、微信字段可以为空，但 `iss`、`aud`、`sub`、`exp` 必须存在。签名算法固定
为 `RS256`，JWT header 必须带 `kid`。

## 请求

商城订单与支付接口：

```text
Authorization: Bearer <consumer access token>
Idempotency-Key: <同一次写操作稳定 UUID>
```

商品、分类接口仍为公开读取。消费者令牌失效返回 `401`；ERP 未配置 JWKS 返回
`503`，不回退到员工账号或匿名下单。
