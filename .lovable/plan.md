## 目标

把"新建 SKU"重写为三条入口：**标准商品（多价格档 → 多 SKU）/ 自定义商品 / 组包商品**。每个 SKU 都保留系统生成的 EPC，并允许额外填一个可选的"商家自编码 sku_code"。手机端只保留"新建自定义商品"。

---

## 数据模型

迁移 `inv_skus`：

- 新增 `sku_code text null`（用户自填编码，nullable，不强制唯一；加普通索引）
- 新增 `kind` 取值 `bundle`（在现有 `single | pack` 之外），用于"组包商品"
- 新增 `bundle_items jsonb default '[]'`：`[{sku_id, qty}]`，仅 `kind='bundle'` 使用
- 保留 `is_custom_price`、`pack_pieces`、`epc` 现有字段不动
- `price_tier` 仍存最终单价：标准档=档位金额，自定义=手填金额，组包=用户手填的整包售价

> 不做"组包扣子 SKU 库存"逻辑（沿用现状：组包是独立 SKU，独立库存）。

---

## 后端 `src/lib/inventory.functions.ts`

把 `createSku` 拆成三个 serverFn，全部返回 `{ skus: [...] }` 以便标准商品一次返回多条：

1. **`createStandardSkus`**：入参 `{ category, name, weight_g?, image_url?, sku_code?, notes?, price_tiers: number[] }` → 校验 `price_tiers` 取自 `PRICE_TIERS`，循环每档生成 `{ kind:'single', price_tier, is_custom_price:false, epc=generateEpc(...) }` 一次 insert。
2. **`createCustomSku`**：入参 `{ category, name, price, weight_g?, image_url?, sku_code?, notes? }` → 一条 `{ kind:'single', price_tier:price, is_custom_price:true }`。
3. **`createBundleSku`**：入参 `{ category, name, price, weight_g?, image_url?, sku_code?, notes?, items:[{sku_id, qty}] }` → 校验 items≥1 且子 SKU 存在；写入 `{ kind:'bundle', price_tier:price, is_custom_price:true, bundle_items:items, pack_pieces=sum(qty) }`。
4. 旧 `createSku` 删除调用方后移除。

`SkuInput`/`updateSku` 同步加 `sku_code` 字段；`lookupSkusByEpcs`、入库 select 增加 `sku_code, bundle_items`。

---

## 前端

### 桌面 `/inventory/skus`（`inventory.skus.index.tsx`）

- 顶部"新建 SKU"按钮改为下拉菜单（DropdownMenu）三项：标准 / 自定义 / 组包。
- 列表卡片：在 EPC 下方多一行 `商家编码：xxx`（有才显示）；`kind==='bundle'` 显示组包 badge + 子项数量。

### 新建对话框（拆三个）

新建 `src/components/inventory/`：

- `standard-sku-dialog.tsx`
  - 表单：类目、品名、商家编码（可选）、单件重量、图片、备注
  - 价格档"多选 chips"（`PRICE_TIERS`），至少选 1
  - 提交后 toast 列出生成的 N 条 EPC
- `custom-sku-dialog.tsx`
  - 类目、品名、自定义价格、商家编码、重量、图片、备注
- `bundle-sku-dialog.tsx`
  - 类目、品名、组包售价、商家编码、重量、图片、备注
  - "添加子 SKU" → 弹一个搜索选择器（复用 `listSkus`，限定 `kind!='bundle'`），可输入品名/EPC 检索，多选并为每项填数量
  - 子项列表展示 缩略图/品名/EPC/单价/数量/小计 + 删除
  - 显示"子项合计参考价 ¥X.XX"，提醒和自填售价的差额

抽公共 `sku-meta-fields.tsx`（类目+品名+商家编码+重量+图片+备注），三个 dialog 共享。

`sku-form-fields.tsx` / `sku-form-dialog.tsx` 现有文件删除（或仅保留 `SkuImagePicker` 提取成 `sku-image-picker.tsx` 供复用）。

### 详情页 `inventory.skus.$id.tsx`

- 在头部信息追加：商家编码（如有）
- 组包商品额外渲染"包含子项"卡片：子项缩略图 + 品名 + EPC + 数量；点击跳转子 SKU 详情

### 移动端 `/m/skus`（`src/routes/m.skus.tsx`）

- "新建"按钮直接打开"自定义商品" Sheet（不暴露标准/组包入口）
- 复用 `custom-sku-dialog` 的内部表单组件
- 列表卡片同样展示商家编码（如有）和组包 badge

---

## 技术细节

- 类型：`SkuKind = 'single' | 'pack' | 'bundle'`；`SKU_KIND_LABEL.bundle = '组包'`。`pack` 现状字段保留兼容旧数据，新建入口不再产生 `pack`。
- EPC：`generateEpc` 不变，组包 SKU 仍用 `INV-{类目}-{价格*10:5位}-{rand6}`。
- `sku_code` 是用户可编辑文本（≤64 字符，可空），不做强校验。
- 入库流程 (`inventory.inbound.new.tsx`)：组包 SKU 也是普通可扫的 EPC，**逻辑无需改**；只在卡片上加 `组包·N` badge。
- 仪表盘、转移、入库的 select 字段补 `sku_code, bundle_items`，但展示侧仅在 SKU 详情/列表用 `bundle_items`。

---

## 变更文件清单

新建：
- `src/components/inventory/sku-meta-fields.tsx`
- `src/components/inventory/sku-image-picker.tsx`（从旧 sku-form-fields 抽出）
- `src/components/inventory/standard-sku-dialog.tsx`
- `src/components/inventory/custom-sku-dialog.tsx`
- `src/components/inventory/bundle-sku-dialog.tsx`
- `src/components/inventory/bundle-children-picker.tsx`
- 一个 supabase 迁移：加 `sku_code`、`bundle_items` 列 + `kind` 允许 `bundle`

修改：
- `src/lib/inventory.functions.ts`（拆三个 createXxxSku、字段补充）
- `src/lib/inventory.helpers.ts`（kind 类型 + label）
- `src/routes/inventory.skus.index.tsx`（DropdownMenu 入口、卡片字段）
- `src/routes/inventory.skus.$id.tsx`（商家编码、组包子项卡片）
- `src/routes/m.skus.tsx`（接到 custom dialog）
- `src/routes/inventory.inbound.new.tsx`（仅 select & badge 适配）

删除：
- `src/components/inventory/sku-form-dialog.tsx`、`sku-form-fields.tsx`（被新组件取代）
