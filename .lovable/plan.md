## 目标

给 APP 商品页做两件事，并把需求整理成一份可以直接转给 Codex 的规格说明：

1. **按商品类型分 Tab**：自定义 / 组包 / 标准（顺序固定，自定义默认）
2. **总仓账号新增「全局库存视图」**：一个入口看到总仓 + 所有分店在所有商品类型上的库存分布

---

## 一、业务背景（先同步给 Codex）

ERP 里商品有 3 种 `kind`：

| kind | 中文 | APP 端优先级 | 是否允许编辑 |
|---|---|---|---|
| `custom` | 自定义商品 | ① 默认落地 | ✅ 门店/仓库可维护 |
| `pack` | 组包商品 | ② | ✅ 可维护 |
| `standard` | 标准商品 | ③ | ❌ 只查/入库，不改 |

`GET /api/public/handheld/products` 已返回 `kind`，但 APP 端把三种混在同一个「商品总账」，用户很难找东西。

---

## 二、需求 A：商品页按 kind 分 Tab

### 页面结构

```text
┌─────────────────────────────┐
│  🔍 搜索商品名/编码/条码      │
├─────────────────────────────┤
│ [自定义 78] [组包 12] [标准 30] │  ← 新增 Tab，角标 = counts
├─────────────────────────────┤
│ 分类▾  排序▾  库位▾           │
├─────────────────────────────┤
│  商品卡片列表 ...             │
└─────────────────────────────┘
```

- Tab 顺序：**自定义 → 组包 → 标准**（固定，不可拖动）
- 默认落地：`自定义`
- Tab 切换保留当前搜索词和排序
- 角标数量随搜索/筛选联动

### 排序选项
最新创建（默认）/ 最早创建 / 价格 ↓ / 价格 ↑ / 库存 ↓

### 筛选
分类多选、库位（受 RBAC 限制）、是否有图（仅 custom）

### 卡片差异

| Tab | 展示重点 | 操作 |
|---|---|---|
| 自定义 | 主图 / 名 / 价 / 库存 / "缺图" 标记 | 建、改、补图、贴标、入库 |
| 组包 | 名 / 明细数 / 总价 / 库存 | 看明细、贴标、入库 |
| 标准 | 名 / 价格档 / 总库存 | **只看 + 入库**，编辑按钮隐藏 |

---

## 三、需求 B：总仓账号的「全局库存视图」

### 权限

- 仅 `role in ('hq_admin','hq_ops')` 或拥有 `all_locations` 权限的用户可见入口
- 分店账号不显示此入口

### 入口位置

APP 商品页顶部工具栏新增按钮 **「🏢 全局库存」**（仅总仓账号显示），点进独立页面。

### 页面结构

```text
┌───────────────────────────────────────────┐
│ 全局库存                                    │
│ [自定义] [组包] [标准]   [切换视图 ▾]        │
├───────────────────────────────────────────┤
│ 🔍 搜索 + 分类/库存高低/缺货筛选              │
├───────────────────────────────────────────┤
│  商品名        总库存   总仓  上海店 广州店…  │
│  皮卡丘公仔      120     80    20    20      │
│  盲盒-A         55      0     30    25   ⚠  │
│  ...                                        │
└───────────────────────────────────────────┘
```

两种视图（右上角切换）：

1. **矩阵视图**（默认）：行=SKU，列=所有 location，格子=库存。总库存列固定；库存为 0 的格子灰色；缺货整行角标 ⚠。横向可滚。
2. **明细视图**：按 SKU 折叠，展开后列出 `location + qty + 最近变动时间`；适合 SKU 多、门店多时用。

### 汇总卡片（页面顶部）

- 商品总数（按当前 Tab 的 kind）
- 库存总件数
- 缺货 SKU 数（total_qty=0）
- 低库存 SKU 数（可配置阈值，默认 <5）

### 交互
- 点击某个 SKU 行 → 进入 SKU 详情，展示每个库位的移库/入库明细
- 点击某个 location 列头 → 快速跳转到该库位视图
- 支持导出 CSV（可选，先不做）

---

## 四、ERP 端接口契约（转达给 Codex）

### 1. 扩展 `GET /api/public/handheld/products`

新增/明确 query：

| 参数 | 类型 | 说明 |
|---|---|---|
| `kind` | `custom`\|`pack`\|`standard` | Tab 过滤（不传=全部）|
| `sort` | `created_desc/asc`、`price_desc/asc`、`stock_desc` | 排序 |
| `category_id` | string | 分类 |
| `location_id` | string | 库位（受 RBAC）|
| `has_image` | `0`\|`1` | 仅 custom 生效 |
| `q` / `page` / `page_size` | | 搜索分页 |

响应新增：

```json
{
  "ok": true,
  "data": { "items": [...], "page": 1, "total": 120 },
  "counts": { "custom": 78, "pack": 12, "standard": 30 },
  "items": [{ "id":"...", "kind":"custom", "editable":true, ... }]
}
```

`counts` 不受 `kind` 影响，但受 `q`/`category_id` 影响，与实际结果一致。

### 2. 新增 `GET /api/public/handheld/global-stock`

**权限**：只有 `hq_admin`/`hq_ops`（或有 `all_locations` 权限）可用；其他角色返回 403。

**Query**：

| 参数 | 说明 |
|---|---|
| `kind` | `custom`\|`pack`\|`standard`，必传 |
| `q` | 搜索 |
| `category_id` | 分类 |
| `stock_state` | `all`\|`out`\|`low`（默认 all）|
| `low_threshold` | 数字，默认 5 |
| `page` / `page_size` | 分页（默认 50）|

**响应**：

```json
{
  "ok": true,
  "data": {
    "locations": [
      { "id":"loc_hq", "name":"总仓", "kind":"warehouse" },
      { "id":"loc_sh", "name":"上海门店", "kind":"shop" }
    ],
    "items": [
      {
        "sku_id":"...",
        "name":"皮卡丘公仔",
        "kind":"custom",
        "image_url":"...",
        "price": 39,
        "total_qty": 120,
        "stocks": { "loc_hq": 80, "loc_sh": 20, "loc_gz": 20 }
      }
    ],
    "summary": {
      "sku_count": 78,
      "total_qty": 3450,
      "out_of_stock": 4,
      "low_stock": 9
    },
    "page": 1,
    "total": 78
  }
}
```

**实现要点**（ERP 端）：
- 数据来自 `inv_stocks (sku_id, location_id, qty)` join `inv_skus` join `inv_locations`
- `stocks` 是 map，前端方便渲染矩阵
- `locations` 按 `warehouse` 优先、然后 `shop` 按名称排序
- 分页只对 `items` 生效，`locations` 全量返回（门店数量有限）
- `standard` Tab 走同一接口，只是 `kind=standard`

### 3. 新增 `GET /api/public/handheld/global-stock/sku/{sku_id}`

进入 SKU 明细页时用，返回每个 location 的：`qty` + 最近 10 条 `inv_stock_movements`。

---

## 五、实施拆分

**ERP 端（Lovable 做）**
1. 扩展 `/handheld/products`（kind/sort/counts/editable）
2. 新增 `/handheld/global-stock` + `/global-stock/sku/{id}`（含 RBAC）
3. 更新 `src/lib/handheld/openapi.ts` + `docs/handheld-api.md`
4. 回复末尾追加「【给 Codex 的指令】」代码块

**APP 端（Codex 做）**
1. 商品页顶部加 3-Tab + 排序 + 筛选
2. 卡片按 `kind` 分样式，`standard` 禁用编辑
3. 总仓账号顶部增加「🏢 全局库存」入口，实现矩阵/明细两种视图
4. 分店账号隐藏该入口
