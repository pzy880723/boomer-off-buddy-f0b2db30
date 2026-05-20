## 背景与定位

把"分拣"从「依附于包裹」的流程，重构成「依附于待分拣库存」的流程。

```text
[ 包裹签收 ]                          [ 后期分拣 / 零售上架 ]
     │                                        │
     │ 自动展开每个 parcel_item               │
     ▼                                        ▼
[pending_sort_items 待分拣库存(袋子)] ──→ [ 拆 SKU + 打 RFID + /inventory/inbound/new 扫枪入库 ]
                                                │
                                                ▼
                                        [ inv_skus.stock_qty++ ]
```

两端**完全解耦**：
- 签收阶段：只生成"袋子"条目，**不算成本**，不动 inv_skus。
- 分拣阶段：只看待分拣袋子，按价格档生 SKU、贴标、入库。袋子拆完后置 `sorted`，**不删除**留档。

包裹的总成本只用于采购统计 / 仪表盘，和零售 SKU 不分摊。

---

## 1. 数据库：新建 pending_sort_items 表

```sql
create table public.pending_sort_items (
  id uuid primary key default gen_random_uuid(),
  parcel_id uuid not null,                  -- 来源包裹（不加 FK，沿用项目风格）
  parcel_item_id uuid not null,             -- 来源 japan_parcel_items.id
  title text,                               -- 冗余存：中文名优先，回退日文
  image_url text,
  source_label text,                        -- "包裹单号 · 卖家" 之类，方便分拣时认袋子
  status text not null default 'pending',   -- pending | sorted | discarded
  notes text,
  received_at timestamptz not null default now(),
  sorted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pending_sort_items_status_idx
  on public.pending_sort_items(status, received_at desc);
create unique index pending_sort_items_uniq_pi
  on public.pending_sort_items(parcel_item_id);   -- 同一子商品只生成一条
alter table public.pending_sort_items enable row level security;
-- 沿用项目当前的 open_* RLS 模板（select/insert/update/delete = true）
```

不做的事：
- 不存任何成本字段（价格、汇率、税费一律不冗余）。
- 不和 inv_skus 建外键关联：分拣是"以这个袋子为参考新建 N 个 SKU"，没有 1:1 数量挂钩。

## 2. 签收阶段：自动落地待分拣条目

在 `markParcelDelivered`（`src/lib/mobile.functions.ts`）成功更新 parcel 状态后，追加一步：

```text
拉取 japan_parcel_items where parent_id = parcelId
  → 对每行 upsert 一条 pending_sort_items(parcel_id, parcel_item_id, …)
     · onConflict: parcel_item_id  → 已存在则跳过，保证幂等
     · title = item_title_cn || item_title || '(未命名)'
     · source_label = `${tracking_no || source_order_no} · ${seller ?? ''}`
```

- 一个 parcel_item 不论 quantity 多少，固定生成 1 条。
- 签收页（`/m/receive/$id`）UI 不动，只是签收成功后多了这步副作用。
- 如果 parcel 没有子商品（极端情况），不生成任何条目，签收照常完成。

## 3. /m/sort 重构为"待分拣库存"列表

`src/routes/m.sort.index.tsx`：
- 不再调用 `listSortQueue`（按包裹聚合），改调新的 `listPendingSortItems()`：
  ```text
  SELECT id, title, image_url, source_label, received_at
    FROM pending_sort_items
   WHERE status = 'pending'
   ORDER BY received_at DESC
   LIMIT 200
  ```
- 卡片：图片 + 标题 + 来源（包裹号 · 卖家） + 入库时间。
- 顶部加一个"已分拣"小 Tab（可选 v2，先只做 pending）。

详情页路由从 `/m/sort/$id`（id=parcel）改成 `/m/sort/item/$itemId`（id=pending_sort_items.id）：
- 顶部展示这个袋子的图片、标题、来源、备注。
- 中间是"拆 SKU"区：
  - 复用现有 `SortItemRow` 的表单（类目 / 价格档 / 名称 / single|pack / 标签份数）。
  - 可以多次添加，每次生成一个 inv_skus + inv_label_batches 行（已有 `sortItemToSku`，参数里 parcel_item_id 仍传袋子背后的 parcel_item_id 仅作溯源）。
- 底部一个按钮「这个袋子分拣完成」：把 pending_sort_items.status 置 `sorted`，写 sorted_at。
- 「这个袋子作废/丢弃」二级按钮：置 `discarded`。

旧的「整包分拣完成」按钮和 `markParcelSorted` 流程移除（包裹层面不再有"分拣"概念）。

## 4. mobile.functions.ts 接口调整

新增：
- `listPendingSortItems({ status?: 'pending' | 'sorted' })`
- `getPendingSortItem({ id })` → 返回袋子 + 已经在它身上生成的 label_batches（按 parcel_item_id 反查）
- `markPendingSortItemDone({ id, action: 'sorted' | 'discarded' })`

保留：
- `sortItemToSku` 不变（parcel_item_id 仍当作"来源溯源"，不再代表"包裹的子项"语义）。
- `undoSortLabel` 不变。

废弃：
- `listSortQueue`、`markParcelSorted`、`getSortDetail` 中按 parcel 维度聚合的逻辑 → 删除。
- 包裹列表 / 包裹详情上一切「分拣进度 / 标记整包分拣完成」UI → 移除。

## 5. 包裹端清理

- `/m/parcels` 已签收 Tab、`/m/receive/$id` 详情页：去掉任何"待分拣 / 已分拣"徽标。包裹生命周期到「已签收」就结束。
- 桌面 `/purchase/japan-parcel/$id`：不动业务字段，只移除（如果有）「分拣完成」相关按钮/状态。

## 6. 不做的事

- 不引入成本分摊、不在 inv_skus 上记任何"来源成本"。
- 不动 inv_apply_inbound_stock RPC、不动 /inventory/inbound/new 扫枪入库流程。
- 不动包裹的 5 档状态字典。
- 不删除已经被 `sortItemToSku` 创建的历史 SKU/标签。

## 7. 风险与回滚

- 已经签收但分拣未完成的老包裹：上线时跑一次性脚本（一次性 SQL），把它们的 japan_parcel_items 也补成 pending_sort_items，避免数据断层。脚本在迁移同一个 migration 内执行。
- 如果未来要做"成本核算"，留了 parcel_id / parcel_item_id 两个溯源字段，能反查回包裹拿到 item_total_cny / 汇率，不会卡死。
- 改完后旧路由 `/m/sort/$id` 立刻 redirect 到 `/m/sort`，避免 PWA 缓存的旧链接 404。

## 实现顺序

1. migration：建表 + 回填历史数据。
2. mobile.functions.ts：加 3 个新 fn，删 2 个旧 fn，改 markParcelDelivered。
3. 路由：新建 `src/routes/m.sort.item.$itemId.tsx`，重写 `m.sort.index.tsx`，删 `m.sort.$id.tsx`。
4. 包裹页清理"分拣"相关 UI。
5. 手动验：签收一个测试包裹 → /m/sort 看到 N 个袋子 → 拆其中一个生 SKU + 标签 → 标记完成 → 回到列表它消失。