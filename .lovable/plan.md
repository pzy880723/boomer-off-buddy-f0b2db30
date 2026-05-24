## 现状梳理

`/m/skus` 列表三种商品当前跳转：

| 类型 | 当前跳转 | 是否手机版 |
| --- | --- | --- |
| 自定义（single + is_custom_price） | `/m/skus/$id` | ✅ 已经是手机版 |
| 组包（kind = bundle） | `/m/skus/$id` | ✅ 已经是手机版 |
| 标准（single 多档聚合） | `/inventory/products/$code` | ❌ PC 版（你看到的问题） |

另外，PC 标准商品详情里点"价格档子 SKU"会跳 `/inventory/skus/$id`（PC 单 SKU 详情）；在手机入口下也应该走 `/m/skus/$id`。

所以真正缺的只有「标准商品的手机版总详情页」。自定义 / 组包不需要改详情，只是列表入口已经对了。

## 改动

### 1. 新建 `src/routes/m.products.$code.tsx`（标准商品总详情 · 手机版）

- 数据：复用 `listSkus` + `groupStandardSkus`（和 PC 版同源），按 `code` 找到对应 group。
- 包在 `MobileShell title="商品详情" back="/m/skus"`，单列竖排：
  1. **主图卡**：满宽 4:3 主图 + 类目/「标准」Badge + 标题；价格区间 `¥min ~ ¥max · N 档` 大字 + 总库存 `N 件`。
  2. **属性卡**（divide-y 一行一项）：商品编码（mono + 复制按钮）、单件重量、价格档数。
  3. **价格档子 SKU 列表卡**：每行 `Badge 价格 · EPC(mono) · 库存 N · ChevronRight`，整行 `<Link to="/m/skus/$id" params={{id: sku.id}}>`，点进去就是已有的手机版单 SKU 详情（可在那里打印 RFID / 看入库记录）。
  4. **备注卡**（若有）。
- 顶栏右上 `rightSlot`：编辑（铅笔图标，打开 `ProductEditDialog`，复用桌面 Dialog，手机也能滚动）/ 删除（垃圾桶图标 + `AlertDialog` + `deleteStandardProduct`，成功后 `nav({to: "/m/skus"})`）。
- 加载中 / 找不到：返回 `/m/skus` 而不是 `/inventory/skus`。

### 2. 修改 `src/routes/m.skus.tsx`

`MStandardRow` 里 `<Link>` 从：
```
to="/inventory/products/$code"
params={{ code: encodeURIComponent(group.key) }}
```
改为：
```
to="/m/products/$code"
params={{ code: encodeURIComponent(group.key) }}
```
其它不动。

## 明确不动的部分

- `m.skus.$id.tsx` 已经是手机版自定义 / 组包详情，**不动**。
- PC 端 `/inventory/products/$code`、`/inventory/skus/$id`、`product-card.tsx` 等 PC 入口，**完全不动**。
- 数据库、serverFn、`ProductEditDialog`、`SkuEditDialog`，全部复用，**不动**。
- 上一轮已修好的 `m.scan.tsx`（扫到 SKU 跳 `/m/skus/$id`），**不动**。

## 一个小取舍

手机版标准商品详情里**不放**"扫枪入库"按钮（手机不接扫枪，入库走 `/m/inbound`，已经在底部 Tab 里）。如果你希望加一个跳"扫枪入库"的快捷按钮，告诉我即可，否则就按上述实现。
