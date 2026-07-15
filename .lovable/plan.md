## 目标
分类新增/编辑时不再让用户填写「短码 (code)」，由后端根据名称自动生成，用户只需填名称、上级、排序、启用状态。

## 改动点

### 1. 后端 `src/lib/categories.functions.ts`
- `UpsertInput`：把 `code` 从「必填」改成「可选」。
- 新增内部函数 `generateCategoryCode(name, parent_id)`：
  - 优先用名称拼音首字母（引入轻量拼音库 `pinyin-pro`，仅在 server handler 内用），全大写，去掉非 `A-Z0-9`。
  - 若拼音结果为空（纯符号）或长度<2，退回 `CAT` 前缀。
  - 拼接 6 位随机 base36 后缀，保证唯一。
  - 循环最多 5 次校验 `inv_categories.code` 是否已存在，冲突则重新生成。
- `upsertCategory` handler：
  - 新增分类且未传 `code` → 调用生成器。
  - 编辑分类：若传了 `id` 且未传 `code`，保留原 `code`（不覆盖）。

### 2. 前端分类管理页 `src/routes/product-categories.tsx`（当前路由）
- 从新增/编辑表单里移除「短码」输入框与相关校验、state。
- 列表里仍然可以只读展示 `code`（方便排查），但表单不再出现。

## 不改的
- 数据库结构不动（`code` 依然 NOT NULL UNIQUE，由后端生成填充）。
- 现有分类的 `code` 不迁移、不重写。
- 其他调用方（`useCategories`、SKU 里以 `category=code` 存储的数据）行为不变。

## 依赖
- 新增 `pinyin-pro`（≈30KB，纯 JS，Worker 兼容），仅在 server function 中动态 `import()`，不进客户端包。
