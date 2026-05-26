## 目标
`/m/parcels` 列表（商品维度 + 包裹维度，待签收 + 已签收 两个 Tab）统一按"签收时间倒序"排序，最近签收的排最前；未签收（received_at 为空）的回退按 created_at 倒序，排在已签收之后。

## 改动
仅改 `src/lib/mobile.functions.ts` 中 `searchParcels` 的排序，UI 不动。

### 商品维度（`mode === "item"`）
当前：pending 按 `japan_parcels.created_at` desc；received 按 `japan_parcels.received_at` desc。
改为：**两个 bucket 统一**
```
.order("received_at", { referencedTable: "japan_parcels", ascending: false, nullsFirst: false })
.order("created_at",  { referencedTable: "japan_parcels", ascending: false, nullsFirst: false })
.order("position", { ascending: true })
```

### 包裹维度（默认分支）
当前：`orderCol = bucket === "received" ? "received_at" : "created_at"`，单字段排序。
改为：去掉 `orderCol`，统一
```
.order("received_at", { ascending: false, nullsFirst: false })
.order("created_at",  { ascending: false, nullsFirst: false })
```

### 效果
- 已签收 Tab：完全按 `received_at` 新→旧。
- 待签收 Tab：极少数有 `received_at`（人工回填/状态回滚）的排最前；其余按 `created_at` 新→旧，与现状一致。
- 分页 `range(from, to)` 不变，无限滚动行为不变。

### 验证
- 已签收 Tab 商品/包裹维度首屏的 `签收 MM-DD HH:mm` 应当从大到小递减。
- 待签收 Tab 无 `received_at` 的项目顺序与之前一致（created_at desc）。