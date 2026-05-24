## 目标

调整"新建标准商品"弹窗的交互；并在三个新建对话框中统一把"商家编码"改名为"商品编码"，留空则后端自动生成。重量在所有场景明确为选填。

---

## 一、价格档可自定义新增（仅标准商品弹窗）

`src/components/inventory/standard-sku-dialog.tsx`

- 在已有 chips（`PRICE_TIERS`）末尾增加一个 `+` 按钮
- 点击后就地展开一个小输入框（数字 + 确认/取消），支持 `Enter` 确认
- 校验：必须 > 0、≤ 9999.9、最多 1 位小数；重复值自动忽略
- 新增的价格档存在弹窗本地 state（`extraTiers: number[]`），关闭弹窗即丢弃；不写库、不污染 `PRICE_TIERS` 常量
- 显示顺序：`[...PRICE_TIERS, ...extraTiers, ...selectedOnlyTiers].sort((a,b)=>a-b)` 去重后渲染；选中状态用 `tiers: number[]`
- 新增并提交时按价格升序生成 SKU

提交逻辑：后端 `createStandardSkus` 当前的 `PRICE_TIER_SET` 白名单需要放宽 —— 改为只校验 `0 < t ≤ 9999.9 且最多 1 位小数`，不再要求必须命中常量。这是为了让"自定义价格档生成的标准 SKU"也能落库（`is_custom_price` 仍保留 `false`，因为是用户认定的"标准档"）。

---

## 二、选档后实时显示将要生成的 SKU 编码

每勾选/取消一个价格档，在 chips 下方实时展示一个预览列表：

```
将生成 3 个 SKU：
  ¥6.9   INV-TY-00069-XXXXXX
  ¥9.9   INV-TY-00099-XXXXXX
  ¥19.9  INV-TY-00199-XXXXXX
```

实现：用 `useMemo` 在选档/类目变化时跑一次 `generateEpc(category, tier)`；为避免每次重渲染都换随机串，把"已生成的 EPC"按 `category+tier` 做 key 缓存在 `useRef<Map>`；取消勾选不清空缓存，重新勾选时复用同一个 EPC。提交时直接把缓存里的 EPC 透传给后端，后端用透传值入库（如未传则后端继续生成）。

后端兼容：`createStandardSkus` 入参增加可选 `epc_map: Record<string /*tier*/, string>`，落库时 `epc: epc_map[t] ?? generateEpc(...)`。

> 仅标准弹窗做这个预览；自定义/组包不变（它们都是单条 SKU，提交时由后端生成 EPC）。

---

## 三、商家编码 → 商品编码 + 自动生成

`src/components/inventory/sku-meta-fields.tsx`

- Label 改为 "商品编码"
- placeholder 改为 "留空则自动生成"
- 字段值（`sku_code`）保持原 schema，仍可空

后端三个 create 函数（`createStandardSkus` / `createCustomSku` / `createBundleSku`）：
- 当用户传入 `sku_code` 为 null/空时，后端根据规则生成：
  - 标准/自定义：`SKU-{类目码}-{YYMMDD}-{4位随机}` 例如 `SKU-TY-260524-A3K9`
  - 组包：`PKG-{类目码}-{YYMMDD}-{4位随机}`
  - 标准多档时，同一品名所有档共用同一个 `sku_code`（在 handler 里一次生成、循环复用）
- 工具函数 `generateSkuCode(category, kind)` 放 `inventory.helpers.ts`

列表/详情现有展示 `商家编码：xxx` 的地方文案改为 `商品编码：xxx`：
- `src/routes/inventory.skus.index.tsx` 卡片
- `src/routes/inventory.skus.$id.tsx` 详情头部

---

## 四、重量明确选填

`sku-meta-fields.tsx`：Label 由 `单件重量 (g)` 改为 `单件重量 (g)（选填）`，无其它变化。三个 create 函数当前 schema 已经是 `nullable().optional()`，无需改动。

---

## 变更文件清单

修改：
- `src/components/inventory/standard-sku-dialog.tsx`（+ 按钮、自定义档输入、EPC 预览缓存、提交带 epc_map）
- `src/components/inventory/sku-meta-fields.tsx`（文案：商品编码、留空自动生成、重量选填）
- `src/lib/inventory.functions.ts`（放宽标准档校验、添加 `epc_map` 入参、三个 create 在 sku_code 为空时调用 `generateSkuCode`）
- `src/lib/inventory.helpers.ts`（新增 `generateSkuCode(category, kind)`）
- `src/routes/inventory.skus.index.tsx`（"编码" 文案）
- `src/routes/inventory.skus.$id.tsx`（"编码" 文案）

不动：移动端 `m.skus.tsx` 复用 `SkuMetaFields`，会自动跟随文案变化；不需要单独改。

数据库：无需迁移。
