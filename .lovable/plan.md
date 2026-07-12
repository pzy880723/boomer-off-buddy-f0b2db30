## 现状

代码里其实已经接入了 `youzan.shop.chain.descendent.organization.list`：
- `src/lib/youzan-api-registry.ts` 已注册 method + 版本 `1.0.1`
- `src/lib/integration-capabilities.functions.ts` 已经把它作为一个能力项列在矩阵里
- `src/lib/youzan.functions.ts` 的「一键检查店铺链路」在总部授权成功后，会自动调用 1.0.1 → 1.0.0 去找当前分店的 `kdt_id` 和 `sell_channel_id`

所以问题不是「没接」，而是这条调用一直失败或者返回里找不到目标分店——我们从没在 UI 里单独看到过它的原始返回。要打破卡点，必须让这一个接口能被单独、反复、可视化地测试。

## 计划

### 1. 让这个接口在「API 联调」页可以单独一键测

在 `src/routes/admin.api-integration.tsx` 的能力矩阵里，把 `shop.chain.descendent.organization.list` 这一行的「测试」按钮做成：
- 点一次自动依次跑 `1.0.1` → `1.0.0`（用总部 token，不需要任何入参）
- 每个版本单独显示：通过 / 失败、trace_id、错误码翻译
- 通过时展开原始 JSON（截断到前 8KB），并高亮列出：返回里所有分店节点的 `kdt_id / shop_name / role / sell_channel_id`
- 特别标注：当前选中的分店 `kdt_id` 是否出现在返回里；如果出现，它对应的 `sell_channel_id` 是多少

这一步的目标是：一眼看清「总部到底能不能看见中信泰富，返回里有没有渠道号」。

### 2. 把「看得见分店」的结果自动落库

如果第 1 步跑通并且返回里包含当前分店：
- 自动把返回中的 `sell_channel_id` 写回 `youzan_shops.sell_channel_id`
- 顺带记录 `hq_can_see_branch = true` 时间戳（复用现有字段或加一个 `hq_link_checked_at`）

这样铺货链路就不再依赖临时探测，后续 `spu.update` / `item.quantity.update` 直接读库里的 `sell_channel_id`。

### 3. 如果 1.0.1 / 1.0.0 都失败，给出明确下一步

在结果面板里根据错误码给白话结论：
- `234000001 系统异常` → 提示这是有赞侧连锁未开通/总部未把该分店纳入组织树，需要在有赞后台把分店挂到总部下
- `40009 / scope 不足` → 提示总部授权缺少「连锁-组织架构」scope，需要重新授权总部
- 授权正常但返回空数组 → 提示总部下确实没有子门店，需要在有赞门店管理里新建/关联

### 不动的部分

- 不改 `pushYouzanQuantityUpdate` / `ensureBranchDistribution` 的核心逻辑
- 不改 registry 已有的其它 10 项能力
- 不引入新表；只在 `youzan_shops` 上写已有字段

### 交付后你要做的验证

1. 打开 `/admin/api-integration`，选中「中信泰富」分店
2. 点「查询总部下分店组织」旁边的测试按钮
3. 看返回里到底有没有中信泰富的 `kdt_id` 和 `sell_channel_id`
4. 结果会直接告诉你卡点是「有赞没把分店挂上来」还是「授权 scope 不够」还是「返回里有但代码没解析对」——三种情况的修法完全不同

要我按这个计划开工吗？