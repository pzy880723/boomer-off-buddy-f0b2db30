# 会员购买上下文 / 语音备注 —— 事实契约审计（2026-10-05，只读）

范围：只审计 Lovable 侧现有表能支撑的事实，不新建客户库、不写数据。腾讯本地 `customer-purchase-notes` 不在此工作副本，需由 Codex 后续对齐。

## 已有可用事实（只读）
| 事实 | 来源表/字段 | 说明 |
| --- | --- | --- |
| 客户主体 | `commerce_customers`(id, phone, wechat_openid/unionid, nickname, status) | 手机号/openid 属个人信息，接口只能回脱敏值 |
| 外部身份 | `commerce_customer_identities`(provider, provider_subject) | 用于 GO/小程序映射 |
| 消费记录 | `commerce_consumption_records`(customer_id, channel, location_id, paid_amount_fen, occurred_at, status) | 购买上下文主来源，含门店维度 |
| 会员权益 | `commerce_membership_entitlements`(tier_code, status, expires_at) | 有效会员判断 |
| 积分/储值 | `pos_customer_wallets`(points, store_credit, member_level) | POS 结账已使用 |
| 订单备注 | `commerce_orders.customer_note` | 客户下单时自填，不是店员备注 |
| 售后备注 | `commerce_after_sales.store_note` | 仅售后场景 |

## 缺口（未实现，未擅自新建）
1. **店员对客户的购买备注**：Lovable 库无该表/字段。
2. **语音备注**：无音频存储字段，也无私有桶约定；转写文本无归属字段。
3. **商品级购买明细到客户**：消费记录是订单级金额，商品行需经 `order_id → commerce_order_items` 关联；POS 线下单与客户的关联取决于结账是否绑定会员。

## 对齐建议（待用户/Codex 决定，不在本轮实施）
- 以腾讯已有 `customer-purchase-notes` 为准，Lovable 只做只读读取或镜像；不在两边各建一份。
- 备注须带 `location_id`、作者、创建时间；门店隔离（仅本店员工可读写），总部只读。
- 语音只存私有桶路径，读取时服务端签名短时 URL；转写文本标注 `source=asr` 且可人工更正。
- 接口返回的手机号/openid 一律脱敏；不返回签名 URL 以外的存储路径。
