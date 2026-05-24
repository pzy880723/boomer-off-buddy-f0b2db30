## 改动概览

把 `/inventory/skus` 从「每个 SKU 一张卡」改为「每个商品一张卡 + 顶部三 Tab」，并新增标准商品聚合详情页。

## Tab 分类

顶部三个 Tab（带计数），默认「标准商品」：

- **标准商品**：`kind=single` 且 `is_custom_price=false`，按 `sku_code || \`${category}|${name}\`` 聚合
- **自定义商品**：`kind=single` 且 `is_custom_price=true`，一 SKU 一卡
- **组包商品**：`kind=bundle`，一 SKU 一卡

搜索框按当前 Tab 过滤。

## 商品卡（`src/components/inventory/product-card.tsx`）

复用现有 `Card + aspect-square` 视觉。三种形态：

- **标准卡**：左上显示前 3 个价格档 Badge（`¥6.9 ¥9.9 ¥15.9`），>3 则追加 `+N`；右上显示「合计库存」=各档求和；底部显示「N 个价格档」而非 EPC
- **自定义卡**：单价 Badge + 「自定义价」+ EPC + 库存
- **组包卡**：「组包·N件」Badge + 价格 + EPC + 库存

## 详情页

- 标准卡点击 → `/inventory/products/$code`（用 `sku_code` 或聚合 key）
- 自定义/组包卡点击 → 沿用 `/inventory/skus/$id`

### 标准商品聚合详情页 `/inventory/products/$code`

布局：
```text
┌─ 顶部 ────────────────────────────────────┐
│ [返回] 品名               [编辑] [新增价格档] │
│ 类目 · 商品编码 · 总库存 N 件                │
├─ 左：商品图 (aspect-square)                │
├─ 右：基本信息（品名/类目/重量/备注/图）       │
├─ 下：价格档列表 (Table)                    │
│   ¥6.9   EPC...  库存 12  [打印] [入库] [↗]│
│   ¥9.9   EPC...  库存  3  [打印] [入库] [↗]│
│   ...                                       │
└────────────────────────────────────────────┘
```

- 「↗」跳到对应价格档子 SKU 的 `/inventory/skus/$id`
- 「打印」复用现有标签批次逻辑（`createLabelBatch`）
- 「入库」跳 `/inventory/inbound/new?epc=...` 预填
- 「新增价格档」沿用 `StandardSkuDialog`，但锁定品名/类目/图（仅选未存在的价格档）—— 本期先放 TODO 占位按钮即可，不实现

## 客户端聚合

`src/lib/inventory.helpers.ts` 新增：

```ts
export type StandardProductGroup = {
  key: string;          // sku_code || `${category}|${name}`
  code: string | null;  // sku_code
  category: string;
  name: string;
  image_url: string | null;
  skus: SkuRow[];       // 按 price_tier 升序
  totalStock: number;
  tiers: number[];      // 升序
};

export function groupStandardSkus(rows: SkuRow[]): StandardProductGroup[];
```

不改 `listSkus` serverFn —— 一次拉全量本地分组即可，三个 Tab 共用同一查询结果。

## 移动端 `/m/skus`

加 Tabs 头 + `ProductCard` 紧凑变体；右上 `新建` 改为下拉菜单（标准/自定义/组包）；点击行为同桌面端。

## 文件改动

新建：
- `src/components/inventory/product-card.tsx`
- `src/routes/inventory.products.$code.tsx`（聚合详情页）

修改：
- `src/lib/inventory.helpers.ts`（加 `groupStandardSkus`）
- `src/routes/inventory.skus.index.tsx`（Tabs + ProductCard）
- `src/routes/inventory.products.tsx`（保留 redirect 到 `/inventory/skus`）
- `src/routes/m.skus.tsx`（Tabs + 三种新建入口）

不动：`inventory.functions.ts`、RLS、schema、`inventory.skus.$id.tsx`。
