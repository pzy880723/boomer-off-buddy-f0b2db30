## 目标

放弃"事后铺货"的三个候选接口，改走**销售渠道修正**这条正路：把 HQ SPU 的 `sell_channel_ids` 从"网店渠道"改成"中信泰富门店渠道"，让门店真正拥有这个商品，再反查分店 item_id 推库存。

## 背景（用人话）

之前的失败原因不是库存 API，而是**建品阶段销售渠道就开错了**——`spu.create` 时传的 `sell_channel_ids` 落在了网店渠道，中信泰富门店从头到尾都没拿到这个 SPU，所以 `item.detail.get` 查不到、`quantity.update` 报"商品ID缺失"。修复方法是用 `spu.update` 把销售渠道改成门店渠道 ID（不是 kdt_id，是有赞连锁体系里门店对应的 `sell_channel_id`），门店端才会看到这个商品。

## 实现步骤

### 1. 新增运维路由 `POST /api/public/hooks/youzan-fix-channel`
沿用 `apikey` 头校验（`SUPABASE_PUBLISHABLE_KEY`）。body：
- `sku_ids?: string[]`（默认两个测试 SKU）
- `branch_shop_id?: string`（默认中信泰富店）
- `dry_run?: boolean`（默认 false）

### 2. 拉取门店组织树，解析目标 `sell_channel_id`
用 HQ token 调 `youzan.shop.chain.descendent.organization.list/1.0.1`，遍历返回的组织树，按 `kdt_id === branch.kdt_id` 匹配到中信泰富门店节点，取该节点的 `sell_channel_id`（若字段不在同层，深度遍历常见字段名 `sell_channel_id` / `sellChannelId` / `channel_id`）。

失败保护：
- 找不到节点 → 直接返回 `error: "branch not found in organization tree"`，不进行下一步。
- 找不到 `sell_channel_id` → 把完整节点 JSON 一并返回，让人工确认字段名。

同时把组织树原始 payload 存一条 `youzan_sync_logs`（`action='chain_organization_list'`）便于复查。

### 3. 逐个 SKU 修正 HQ SPU 销售渠道
用 HQ token 调 `youzan.retail.open.spu.update/3.0.0`，参数：
```
spu_id: HQ SPU id （从 sku_youzan_links.role='hq_spu' 取）
sell_channel_setting_request: {
  is_partial: 1,
  sell_channel_ids: [ 上一步拿到的门店 sell_channel_id ]
}
```
只放门店渠道，不放网店渠道。记 `youzan_sync_logs`（`action='fix_sell_channel'`），保留 trace_id + preview。

### 4. 用**分店 token** 反查分店真实 item_id / sku_id
用中信泰富 access_token 调 `youzan.item.detail.get/1.0.0`，参数 `node_kdt_id = 分店 kdt_id`、`spu_id = HQ SPU id`。深度遍历 payload 抽取 `item_id` / `sku_id`。
- 抽到 → 回写 `sku_youzan_links`（`role='branch_stock'`，`shop_id=分店`）的 `yz_item_id` / `yz_sku_id`。若原 link 不存在则 upsert。
- 抽不到 → 记 `youzan_sync_logs` `action='branch_item_probe'` `status=error`，返回 `branch item not visible`，**跳过库存推送**，不再往下走。

### 5. 用分店 token 覆盖库存
`youzan.item.quantity.update/4.0.0`，参数：
```
kdt_id: 分店 kdt_id
item_id / sku_id: 上一步反查到的真实值
channel: 1
stock_num_str: String(ERP 当前库存)  // ERP 侧 stock_qty，测试默认 "1"
```
记 `youzan_sync_logs` `action='quantity_update'`，保留 trace_id。

### 6. 主链路守护：禁用 `stock.adjust/3.0.0`
在 `src/lib/youzan-sync.functions.ts` 内所有推普通门店销售库存的路径里，只允许 `youzan.item.quantity.update/4.0.0`。搜索现有 `stock.adjust` 调用点，若有，加短路：`throw new Error('stock.adjust disabled for branch sales stock; use item.quantity.update')`。同时把 `youzan-api-registry.ts` 里 `retail.open.stock.adjust` 的条目标记 `in_use: false` + `note: '禁止用于普通门店销售库存推送'`。

### 7. 注册表补记
`youzan-api-registry.ts` 增补：
- `shop.chain.descendent.organization.list/1.0.1`（token_scope: hq，business_scene: 门店组织树查询）
- 更新 `retail.open.spu.update/3.0.0` 说明加入"用于修正 sell_channel_setting_request 到门店渠道"

### 8. 返回结果结构
```
{
  ok: boolean,
  branch: { shop_id, kdt_id, sell_channel_id },
  results: [
    { sku_id, hq_spu_id,
      steps: {
        fix_channel: { ok, trace_id? , error? },
        branch_probe: { ok, item_id?, sku_id?, error? },
        quantity_update: { ok, trace_id?, error? }
      }
    }
  ]
}
```

## 验证

调用一次 `POST /api/public/hooks/youzan-fix-channel` 空 body（默认两个测试 SKU + 中信泰富），预期：
- 组织树日志能看到中信泰富节点及其 `sell_channel_id`。
- 两个 SKU 的 `spu.update` 返回 ok + trace_id。
- `item.detail.get` 能反查到 branch item_id 并回写。
- `quantity.update` 返回 ok + trace_id，有赞中信泰富店后台库存 = 1。

任一环节失败，日志里保留原始有赞报错和 trace_id，不再继续下一步。

## 不动的东西

- 不改 `ensureBranchProduct` 现有主链路（等这个修复流程验证通过后再单独重写建品阶段的 `sell_channel_ids`）。
- 不动之前的 `youzan-distribution-probe` 和 `youzan-relist` 路由。
- 不动 `spu.create` 逻辑本身；本轮只做"事后修正"，下一轮再回头把 `spu.create` 的 `sell_channel_ids` 默认改成门店渠道。
