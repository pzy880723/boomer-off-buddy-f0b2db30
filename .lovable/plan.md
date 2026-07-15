## 目标
在 `/product-brands` 页顶部加 Tab 筛选，把「制造商」合并进「品牌」，Tab 分为三块：**品牌**、**窑口**、**IP（动漫）**。

## 变更点

### 1. 数据侧（一次迁移）
- 将 `inv_brands` 中 `entity_type='manufacturer'` 的记录批量更新为 `'brand'`。
- 新增 IP 类型：扩展 `entity_type` 枚举加入 `'ip'`（保留 `studio`/`designer` 以兼容旧数据，但 UI 不再单独暴露）。
- 对现有明显是 IP / 动漫题材的品牌（如吉卜力、万代等）批量归类为 `'ip'`；不确定的保持 `'brand'`，后续可在编辑里手动调整。

### 2. 前端 `src/routes/product-brands.tsx`
- 顶部加 `Tabs`：`全部 / 品牌 / 窑口 / IP`（默认「全部」）。
- 每个 Tab 显示该分类下的数量徽章。
- 列表按当前 Tab + 搜索关键字过滤。
- 「新建品牌」按钮根据当前 Tab 预设 `entity_type`（在 IP Tab 下默认新建为 IP）。
- 编辑弹窗的「类型」下拉精简为三项：品牌 / 窑口 / IP（动漫）。旧的 `manufacturer / studio / designer` 若历史数据存在则只读展示，不出现在下拉里。

### 3. 侧栏 & 文案
- 侧边栏入口名称由「品牌 / 制造商」改为「品牌 / 窑口 / IP」。
- 页面标题与描述同步更新。

## 不做
- 不动 `inv_skus.brand_id` 关联逻辑。
- 不改搜索/别名匹配规则。
- 不动其他页面。
