## 目标
1. 修复 `/settings` 顶部页签溢出/重叠的视觉问题，重新设计得更精致。
2. 商品分类的「从有赞同步」目前只拿了一级类目，改为同步一级 + 二级，并在本地以父子结构呈现。

---

## 1. 设置页导航重构（视觉）

问题：目前 9 个 tab 用 `TabsList flex-wrap` 挤在一行，换行后 chip 视觉粘连、没有对齐，也看不出层级。

方案：**左侧竖向导航 + 右侧内容**（桌面），移动端回退为顶部横向滚动条。

```text
┌─────────────────────────────────────────────┐
│ 系统设置                                     │
├──────────┬──────────────────────────────────┤
│ 账户     │                                  │
│  基本信息│                                  │
│  成员权限│         <TabsContent />          │
│  地址库  │                                  │
├──────────┤                                  │
│ 商品     │                                  │
│  商品分类│                                  │
├──────────┤                                  │
│ 通知与集成│                                 │
│  通知    │                                  │
│  集成    │                                  │
│  Webhook │                                  │
│  API 密钥│                                  │
├──────────┤                                  │
│ 安全     │                                  │
│  审计日志│                                  │
└──────────┴──────────────────────────────────┘
```

- 左侧宽 `w-56`，分组标题（账户 / 商品 / 通知与集成 / 安全）用 uppercase 小灰字，每项 icon + label + hover 高亮 + 选中态左边框主题色。
- 移动端 (`md:` 断点以下) 折叠为顶部横向滚动的 chip 行，避免换行重叠。
- 复用 `Tabs` 组件 API：把 `TabsList` 换成自绘的按钮列表，`TabsTrigger` 仍然驱动状态；`TabsContent` 结构不动，路由 hash（可选）不做。
- 只改视觉与结构，不改任何 tab 里已有的业务代码。

---

## 2. 商品分类：同步一级 + 二级

### 有赞侧
`fetchYouzanHqCategories`（`src/lib/categories.functions.ts`）目前只调用 `youzan.retail.product.standardcategory.get` / `youzan.itemcategories.get`，很多店铺这两个接口只返回一级。改造：

1. 先拿一级列表。
2. 对每个一级 category 调 `youzan.itemcategories.get.byparentcid`（零售版备用：`youzan.retail.product.category.get` + `parent_cid`）拉子类目，`parent_id` 设为父的 `id`。
3. `normalizeCats` 已能递归 `children`/`sub_categories`，扩展成先递归、再对没有 children 的节点补一次 by-parent 请求。
4. 拉取失败的分支只降级为「一级同步」，不影响主流程；同步预览里会额外显示接口列表与每步计数。

### ERP 侧数据模型
`inv_categories` 已有 `parent_id`。新增列（迁移）：
- `youzan_hq_parent_id bigint` — 记录有赞侧父类目 id，用于二次同步时正确建立父子关系。

### 采纳流程调整
- Preview 结果按父分组：`to_add` 里同时给出 `parent_youzan_id`；服务端 apply 时先按父 → 子顺序插入，父插入完成后立刻拿到本地 `id`，再把子的 `parent_id` 填上。
- 已存在的一级需要保持稳定：优先按 `youzan_hq_category_id` 匹配；新建时若父 id 在本次 batch 中，用刚建好的 id 关联。
- Update 分支保留（重命名），Deactivate 分支保留。

### 列表 UI
- `CategoriesPanel` 展示时按 `parent_id` 建树：
  - 一级顶行，二级缩进（左 `pl-8`）＋ 前缀 `└ `。
  - 折叠/展开一级；有二级时右侧显示 `Badge` 计数（如 `含 5 个子类`）。
- Preview 弹窗里的「新增」也分组渲染：以「父类目名 / 未映射」为 group，子项缩进。

---

## 技术细节

### 修改文件
- `src/routes/settings.tsx` — 替换 `TabsList`/`TabsTrigger` 布局为分组侧边栏；移动端切换 chip 滚动条。
- `supabase/migrations/*_inv_categories_parent_yz.sql` — `ALTER TABLE inv_categories ADD COLUMN youzan_hq_parent_id bigint;`
- `src/lib/categories.functions.ts`
  - `fetchYouzanHqCategories`：新增二次拉取 by-parent 的兜底。
  - `previewYouzanCategorySync`：为每个待新增项带上 `parent_youzan_id`。
  - `applyYouzanCategorySync`：两遍插入（父先子后），把 `parent_id` 正确回填；同时写入 `youzan_hq_parent_id`。
- `src/components/settings/categories-panel.tsx`
  - 列表树形渲染 + 展开折叠。
  - Preview 弹窗按父分组。
  - `EditDialog` 修一个已有 bug：`useState(() => {...})` 用来「重置」是错误的（`useState` 的 initializer 只跑一次），改成 `useEffect` 依赖 `initial`。

### 不改动
- `inv_categories` 其余字段、`useCategories` hook 消费方式、SKU 编辑下拉不变（仍按 `code` 匹配）。
- 其它 8 个 settings tab 内部内容零改动。

## 验收
1. `/settings` 桌面端左侧分组侧边栏、右侧内容；移动端顶部滚动 chip；无重叠、无换行溢出。
2. 点「从有赞同步」预览里能看到二级类目，按父分组展示；采纳后本地列表以树状展示，父子 `parent_id` 正确。
3. 已存在的一级不重复新增；有赞侧删除的类目仍能识别为「可停用」。