## 目标
给 `japan_parcels` 和 `japan_parcel_items` 各补 2 个缺失字段：
- `created_by uuid` — 插入时自动写入当前登录用户
- `system_code text` — 自动序列号，包裹 `P-YYYYMMDD-####`，商品 `I-YYYYMMDD-####`

`created_at` 已存在，复用即可。然后在所有展示这些数据的界面把"添加时间 / 添加人 / 系统编码"显示出来。

## 一、数据库 migration

两张表都做相同的事：

1. `ALTER TABLE` 加 `created_by uuid` 和 `system_code text unique`。
2. 建 BEFORE INSERT 触发器 `tg_japan_parcels_defaults` / `tg_japan_parcel_items_defaults`：
   - 若 `NEW.created_by IS NULL` → 写 `auth.uid()`
   - 若 `NEW.system_code IS NULL` → 计算当天序列号
     ```
     prefix := 'P-' || to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYYMMDD') || '-';
     SELECT COALESCE(MAX(SUBSTRING(system_code FROM '\d+$')::int),0)+1 INTO n
       FROM japan_parcels WHERE system_code LIKE prefix || '%';
     NEW.system_code := prefix || lpad(n::text,4,'0');
     ```
     商品表前缀用 `'I-'`。
3. 历史数据回填：按 `created_at` 升序 + ROW_NUMBER OVER (PARTITION BY 当天) 一次性生成 `system_code`。`created_by` 历史留 NULL（无法回溯）。
4. 索引：`CREATE INDEX ON japan_parcels(system_code)` / 同 items。

> 注：参考已有的 `gen_stock_transfer_code()` 风格；按 Asia/Shanghai 时区分天。RLS 已是 authenticated 全开，无需新策略。

## 二、Server 层 / 类型
- migration 跑完 `types.ts` 自动刷新，无需手改。
- `src/lib/mobile.functions.ts` 的 `searchParcels` SELECT 列表追加 `system_code, created_by, created_at`（包裹和商品两个分支都加）。
- `src/lib/japan-parcel.functions.ts` 读详情/列表的 SELECT 同样追加这 3 个字段。
- 新建一个轻量 serverFn `getUsersByIds(ids: string[])` → 从 `auth.users` 取 `email` / `raw_user_meta_data.name`，返回 `Record<id,{name,email}>`，给 UI 渲染"添加人"。用 `supabaseAdmin`。

## 三、UI 展示位置（全部地方）

统一展示格式：`系统编码 · 添加人 · 添加时间`，使用 `font-mono text-[10px] text-muted-foreground`，复制按钮可选。

1. **移动端列表 `/m/parcels`**（`src/routes/m.parcels.tsx`）
   每个 li 在 orderNo 行旁追加一行 `<div>{system_code} · {addedBy} · {fmtDateTime(created_at)}</div>`，参与 `highlight(q)` 高亮。
2. **移动端商品详情 sheet**（`src/components/mobile/item-detail-sheet.tsx`）
   在底部"备注"上方加一段 Sep + 3 行 Row：系统编码 / 添加人 / 添加时间。
3. **移动端包裹收货 `/m/receive/$id`**（`src/routes/m.receive.$id.tsx`）
   顶部 meta 区追加系统编码 + 添加人 + 添加时间。
4. **桌面端包裹列表 `/purchase/japan-parcel`**（`src/routes/purchase.japan-parcel.index.tsx`）
   在表格头加一列"系统编码"（默认显示），鼠标 hover 时 tooltip 显示"添加人 · 添加时间"。
5. **桌面端包裹详情 `/purchase/japan-parcel/$id`**（`src/routes/purchase.japan-parcel.$id.tsx`）
   - 包裹卡片头部展示 `系统编码`
   - 商品行展示每条 item 的 `I-...` 编码
   - 元信息块新增"添加人 / 添加时间"
6. **包裹卡片对话框 / 商品卡片对话框**（`src/components/japan-parcel/parcel-card-dialog.tsx`、`item-card-dialog.tsx`）
   底部 meta 区补 3 行。

## 四、验收
- 新建/导入的包裹和商品自动获得 `P-YYYYMMDD-0001` / `I-YYYYMMDD-0001`，且 `created_by` 等于当前登录用户。
- 旧数据有顺序连贯的历史 system_code，添加人栏显示 `—`。
- 移动端列表搜索 `P-20260526` 能匹配并高亮。
- 桌面端列表新增列可排序/筛选。
