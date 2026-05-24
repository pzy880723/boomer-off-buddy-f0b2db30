## 目标
让"新建标准商品"对话框里的标准价格档（之前写死在常量里的 6.9 / 9.9 / 15.9 …）变成可增、可编辑、可删除的全局配置，所有人 / 所有 SKU 新建对话框共用同一份，编辑后立刻持久化。

## 改动点

### 1. 数据库：新增 app_settings 表
单行键值表，用来存全局通用设置（先用于价格档，后续也可放别的配置）。

- 表 `public.app_settings`
  - `key text primary key`
  - `value jsonb not null`
  - `updated_at timestamptz`
- RLS：与项目其它表一致，`authenticated` 可读、可写。
- 初始化一行 `key = 'inv_price_tiers'`, `value = [6.9, 9.9, 15.9, 19.9, 29.9, 39.9, 49.9]`（与现 PRICE_TIERS 一致，老用户首次进来不会"突然变空"）。

### 2. 新建 server 函数 `src/lib/app-settings.functions.ts`
- `getPriceTiers()`：读 `app_settings.inv_price_tiers`，没有就返回默认常量。
- `setPriceTiers({ tiers: number[] })`：写回（去重、排序、限制 0~9999.9 且最多 1 位小数、最多 ~30 项）。
- 两个都用 `requireSupabaseAuth`。

### 3. 新建 `src/components/inventory/price-tier-editor.tsx`
对话框里那一块价格档区域抽成独立组件，行为：
- 通过 react-query 拉取全局价格档；展示成一排按钮（与现在一致：选中 → primary，未选中 → outline）。
- 每个价格按钮：
  - 点击 = 勾选 / 取消勾选（不进入编辑态，避免误触）。
  - 按钮右上角悬浮显示一个小 `-` 角标按钮（hover 出现，移动端长按出现）→ 二次确认后从全局列表删除；同时取消该档勾选。
  - 按钮上长按 / 右键 / 旁边出现的"铅笔"小图标 → 进入"编辑该档"内联输入框，回车保存，Esc 取消。
- 末尾「+」按钮：点击后变成内联输入框，**回车键直接新增**并自动勾选；Esc 取消；失焦也提交。
- 任何"新增 / 编辑 / 删除"操作都立即 `setPriceTiers` 写库，并 invalidate `['inv-price-tiers']`，所有打开的对话框会同步刷新。
- 删除二次确认用一个轻量 AlertDialog（"删除后所有员工新建 SKU 的对话框都会少这一档，确定吗？"）。

### 4. 改造 `standard-sku-dialog.tsx`
- 去掉本地的 `extraTiers` / `adding` / `newTierInput` / `confirmAddTier` 状态。
- 价格档区域整块换成 `<PriceTierEditor value={tiers} onChange={setTiers} category={meta.category} />`，由它内部负责数据源 + 编辑 UI。
- EPC 预览区保持不变（仍按 `sortedSelected` 渲染）。

### 5. 清理 / 兼容
- `src/lib/inventory.helpers.ts` 的 `PRICE_TIERS` 常量保留作为"默认值兜底"，但注释改为"默认值，运行时以 app_settings 为准"。
- `src/lib/mobile.functions.ts` 里的 `MOBILE_PRICE_TIERS` 改成调用 `getPriceTiers()`（同一份数据源，保持端一致）；如果调用方很多、改动太大，则在该函数里直接 await 一次后透传，外层调用接口保持不变。

## 交互细节回顾
- 输完价格按 **Enter** → 立即新增并勾选（满足"回车键就新增"）。
- 点击价格按钮 = 勾选/取消（这是高频操作）；**点击价格按钮上的「-」角标** = 删除该档（全局）。
- 想"编辑价格"：每个按钮旁边露出一个小铅笔图标 → 弹出内联输入框 → 回车保存。
  - 这样把"勾选 / 编辑 / 删除"三个动作清晰拆开，避免单击一下既改了价又取消了勾选。
- 全部写库后会触发其它打开窗口刷新，达成"编辑一次就记录下来，之后新建都会这么显示"。

## 不在本次改动范围
- 不动 SKU 表结构、不动 EPC 生成逻辑、不动其它 SKU 类型（自定义价 / 组包）的对话框。
- 不做"价格档历史 / 回收站"。删错了重新加即可。
