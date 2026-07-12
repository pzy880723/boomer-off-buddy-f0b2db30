## 目标

`/admin/api-integration` 卡片左栏做三件事：
1. 能力名改成一眼看懂的大白话（不再写「获取店铺 access_token」「查询总部下门店组织树」这种术语）。
2. 用 2–4 句话讲清楚：**这个接口是干嘛的 / 解决什么问题 / 通了之后系统能做什么**。
3. 把对判断/使用这个接口没帮助的信息藏起来，文档按钮精确指向该接口自己的文档页。

## 一、重写每一项能力的名字和说明（数据库 migration）

新建一次 migration，`UPDATE integration_api_registry` 覆盖 11 项能力的 `capability_name`（大白话短标题）和 `requirement`（3–4 句大白话），示例：

| capability_key | 新短标题 | 新说明（示例） |
|---|---|---|
| auth.silent_token | 给店铺换一把"进门钥匙" | 我们用这把钥匙才能替这家店读订单/改库存。总部和分店必须各换各的，30 天到期系统会自动续。通了 → 这家店后续所有有赞操作才有权限。 |
| shop.chain.descendent.organization.list | 拿到总部下所有分店清单 | 系统需要知道总部下面挂了哪几家分店，以及每家分店的"网店渠道 ID"。只有拿到渠道 ID，才能把总部的商品定向铺到指定分店。通了 → 新分店会自动出现在门店列表。 |
| trades.sold.get | 拉取分店最近的订单列表 | 用来在仪表盘看某家店近 24 小时的销售额和订单数，也是自动同步订单的入口。通了 → 首页 / 门店卡片的营业额、订单数才会有数据。 |
| trade.get | 补拉某一笔订单的完整详情 | 有赞推消息过来时只给一个订单号，我们必须再拉一次完整数据才知道买了啥、发没发货。通了 → 有赞下单/退款推送才能变成本地真实订单记录。 |
| retail.open.online.spu.query | 反查某个商品在分店的真实编号 | 总部建好的商品铺到分店后，分店那边会重新分配一个 item_id，不查就没法改分店库存。通了 → 系统可以把总部商品跟分店真实商品对上号。 |
| item.detail.get | 反查分店商品的 SKU 编号 | 分店改库存需要 sku_id，只能拿分店 token 到分店那边查。通了 → 覆盖式改库存才不会报"301000002 找不到商品"。 |
| retail.open.spu.create | 在总部创建一个新商品 | 我们所有商品都先在总部建，再铺给分店，这是入口。通了 → ERP 里的中古杂货 SKU 可以一键推到有赞。 |
| retail.open.spu.update | 让总部商品在指定分店上架 | 建完商品后要告诉有赞"这个商品允许在中信泰富分店卖"，否则分店看不到。通了 → 分店 storefront 才会出现新品。 |
| retail.open.spu.delete | 清理误建的测试商品 | 只在运维时用；主流程绝对不会自动调它。手动填 spu_code，双重确认后才删。 |
| item.quantity.update | 把 ERP 库存推到分店 | ERP 里加减库存后，用这个接口把最新数字覆盖到分店。通了 → 有赞前台库存永远和 ERP 一致，不会超卖。 |
| materials.storage.platform.img.upload | 把商品图上传到有赞图床 | 有赞只认自己 CDN 上的图，本地图必须先传过去拿到新地址再存到商品里。通了 → 分店商品才会有封面图。 |

同一次 migration 顺便把 `doc_url` 更新成后面「文档链接」章节里那份准确映射。

## 二、左栏 UI 精简（`src/routes/admin.api-integration.tsx`）

保留 & 突出：
- 大白话短标题 + 状态徽章（未测试 / 已通过 / 未通过）。
- 新的 3–4 句「这个接口是干嘛的」说明（原 `requirement`）。

折叠进「技术信息」`<details>`（默认收起）：
- 接口全名 `method.version`
- 使用授权（总部/分店）
- 作用范围
- 备注

按钮区保留：查看有赞文档 / 修改配置 / 恢复默认（不动逻辑，只是排版跟着简化）。

## 三、文档链接精确指向对应接口

现在 `docLinkFor` 一律走搜索页，命中率差。改成：

1. 在文件里维护一份 `DOC_URL_BY_METHOD` 手工映射（用真实核对过的有赞文档 detail 页 ID），能命中就直接跳 detail 页。
2. 命中不到再退回 `https://doc.youzanyun.com/list?keyword=<method>` 分类搜索页。
3. `retail.open.spu.create / update / delete` 现在在 DB 里都写成同一个 1788 是错的，本次一起在 migration + 前端映射里拆开成各自 detail ID（找不到确切 ID 的先退到 list 搜索页，也比现在跳错强）。

前端 `docLinkFor(method, cap.doc_url)`：优先用 `DOC_URL_BY_METHOD[method]`，再用 `cap.doc_url`，最后 fallback 到搜索页。

## 不改动

- 右栏「立即测试」面板、参数字段、confetti 效果、编辑弹窗的「接口全名」输入格式，全部保留。
- `integration-capabilities.functions.ts` 后端逻辑不动。
- 其他页面 / 路由 / 侧边栏不动。

## 验收

1. `/admin/api-integration` 每张卡片左栏第一眼看到的是大白话短标题 + 3–4 句「这是干嘛用的」；技术字段默认收起。
2. 点每张卡片的「查看有赞文档」，跳的都是这个接口自己的页面，不再是无关列表。
3. 已测过的卡片仍然显示「已通过」绿标；已改写的仍然显示「已改写」和恢复默认按钮。
