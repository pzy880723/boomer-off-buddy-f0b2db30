## 目标

在「新建小包裹」页（`/purchase/japan-parcel/new`）的页头操作区，在现有「保存」按钮旁新增一个「保存并继续添加」按钮：保存成功后不跳转回列表，而是清空当前表单回到一个新的空白新建状态，方便连续录入多条。

## 改动范围

仅改一个文件：`src/routes/purchase.japan-parcel.new.tsx`。属于纯前端 UI/交互调整，不动 server function、不动数据库、不动列表页。

## 具体方案

1. 把现有 `saveMut` 从「成功后固定跳转列表」改为可带参数：
   - 给 mutate 调用传入一个 `continueAdding: boolean` 标记（用 `useMutation` 的 variables 即可，无需新增 mutation）。
   - `onSuccess` 里：
     - `continueAdding = false`（默认「保存」按钮）：维持现状，toast 提示并 `nav` 回 `/purchase/japan-parcel`。
     - `continueAdding = true`（新按钮）：toast 提示「已保存，继续添加下一单」，然后重置本地 state：`setParcel(emptyParcel())`、`setIntl(emptyIntl())`、`setItems([emptyItem()])`、`setUsedAi(false)`、`setSmartOpen(false)`，并把页面滚动到顶部。

2. 在 `PageHeader.actions` 中，紧挨现有「保存」按钮新增一个 `Button`：
   - 文案：`保存并继续添加`
   - 图标：`Save` + `Plus` 组合，或直接用 `Plus`
   - 样式：`variant="outline"` `size="sm"`，与「保存」做主次区分（保存仍是品牌渐变主按钮）
   - 行为：`onClick={() => saveMut.mutate({ continueAdding: true })}`，pending 时 disabled，按钮文字切换为「保存中…」
   - 现有「保存」按钮同步改为 `saveMut.mutate({ continueAdding: false })`

3. 顺手把 `saveMut` 的 `mutationFn` 改成接收 `{ continueAdding }` 参数，并在 `onSuccess` 中通过第二个回调参数（variables）读取该标记，做条件分支。

## 不做的事

- 不新增草稿/历史记录功能。
- 不改保存的数据结构、不动 server function。
- 不调整列表页或详情页。
- 不引入新的依赖。
