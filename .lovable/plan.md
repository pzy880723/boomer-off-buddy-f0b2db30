# 翻筐乐（100件一筐 + 1%赠礼盲盒）只读核查结果与最小变更点

本文件仅为只读核查结论，未改代码/数据库，未发布。批准后也只会按授权另行实施。

## 1. 当前版本
- 工作副本 HEAD：`a9b99c3252af802286ab9d1be36a4f21c3a6e855`（Complete Fankuang enrollment clients and Tencent release verification），工作区干净。
- 最新迁移：`drizzle/migrations/0045_fankuang_override.sql`（journal 已登记）。`supabase/migrations/` 为旧历史（最后 20261003140000），不再新增。

## 2. 后端实现与主库判断
- 服务端：TanStack Start server routes，消费者接口在 `src/routes/api/public/storefront/*`。
- 数据访问：路由通过 `supabaseAdmin.rpc(...)`（Supabase/PostgREST 客户端）调用 SQL 函数；Drizzle 仅作迁移运行器（`drizzle/schema.ts` 为空，仅"do not edit"注释，无 Drizzle ORM 查询）。
- 是否以 Tencent PostgreSQL+Drizzle 为实际生产主库：仓库内无法证实。代码层面无直连 `DATABASE_URL`/`drizzle(...)` 的读写路径，访问方式仍是 Supabase 客户端；腾讯侧实际连接哪个库需 Codex 在腾讯环境读回环境变量指向（不输出值）确认。未验证。

## 3. 赠礼 SKU / 库存
- 全仓 `src`、`drizzle/migrations` 搜索 gift / 赠礼 / 盲盒 / blind_box：无业务实现（仅 mock-data 与调拨对话框的无关文字）。无赠礼 SKU、赠礼库存、中奖记账表。
- 翻筐乐现状仅有 `inv_skus.fankuang_override` + `src/lib/commerce/fankuang.ts`（有效参与判定）和商城 `fankuang=1` 分页前过滤；无"筐"、每日重排、冻结快照、喜好表。

## 4. 订单/报价结构
- 下单：`src/routes/api/public/storefront/orders.ts`
  - 输入：`items` 或 `listing_ids`（二选一）、`fulfillment_method: 'express'|'pickup'`（默认 express）、优惠券、收货信息、幂等键；经 `src/lib/commerce/storefront-order-request.ts` 的 `normalizeStorefrontOrderItems` 归一。
  - 原子写入位置：DB RPC `commerce_create_ordinary_order`（快递）/ `commerce_create_ordinary_pickup_order`（自提，0040/0044），数据库内重算价格/券/库存/方式并幂等；随后 `recordOrderOrigin`。
  - 错误码：`coupon_unavailable` 409、`fulfillment_method_conflict` 409。
- 详情/列表：`orders.$id.ts`、`orders.ts` GET（`storefrontPrivateJson`，no-store）。
- shipping-quote：本仓库无该路由文件，仅为腾讯专属 overlay（调用 `commerce_quote_checkout`/v2，pickup_v1 零运费）。输入输出以腾讯基线为准，本仓库不能覆盖。
- 商品：`products.ts` / `products.$id.ts`（返回 `in_fankuang`）。

## 5. 预计最小变更点（未实施）
数据层（新增迁移 0046+，不改已应用文件）：
- `commerce_fankuang_baskets`（日期、筐号、Asia/Shanghai 业务日、seed）与 `commerce_fankuang_basket_slots`（筐、位次、listing/sku），00:00 上海时区重排由腾讯 systemd timer 调 RPC 生成；售出/下架空位按新上架补位。
- `commerce_fankuang_sessions`（顾客、筐、快照 listing 列表、状态）实现"翻完前冻结"。
- `commerce_fankuang_preferences`（个人隐藏/喜好，只过滤本人视图）。
- `commerce_fankuang_flips`（顾客、session、listing、client_op 唯一）+ 抽奖结果在 RPC 内服务端随机一次落库，重复请求返回原结果，防刷新重抽；仅"真实有效商品"首次翻动计入。
- `commerce_gift_entitlements`（中奖赠礼额度、状态、绑定订单）。
- 赠礼 SKU：在 `inv_skus` 用标准商品承载（需字段或配置标识为赠礼盲盒 SKU），消费者端只显示盲盒，不暴露具体商品。
- 下单 RPC 扩展：`commerce_create_ordinary_order` / pickup 版及 `commerce_quote_checkout_v2` 新增可选 `p_gift_count`；校验 赠礼数 ≤ 付费件数（含特价清仓）且 ≤ 可用中奖额度，不满足返回 409 `gift_exceeds_paid_items`（提示减赠礼或加购）；赠礼行写入 `commerce_order_items`（单价0、标记赠礼），走原库存/配货链路，ERP 配货可见赠礼 SKU 数量。须以 `pg_get_functiondef` 当前定义为基准扩展，保留券/运费快照/幂等。

接口层：
- 新增 `storefront/fankuang.basket.ts`（取今日筐/冻结快照）、`fankuang.flip.ts`（POST，client_op 幂等，返回是否中奖）、`fankuang.preferences.ts`、`gifts.ts`（可用赠礼额度）。
- `orders.ts` 输入加 `gift_count`；腾讯 shipping-quote overlay 由 Codex 对应加字段。
- ERP 配货页显示赠礼行（现有订单明细组件加标记）。

## 6. 需确认的问题（实施前）
- 赠礼盲盒 SKU 由谁建、库存从哪个门店扣；跨店订单赠礼分配到哪个子单。
- "真实有效翻动"的判定（停留时长/去重口径），以及每日中奖上限。
- 冻结快照中途商品被他人买走时如何展示。

## 技术约束
- 不改旧内嵌库数据，不造假库存/订单/付款，不写有赞，不部署腾讯；Lovable 预览不等于腾讯上线。
