# 日本小包搜索：加按钮 + 修复

## 现状排查

`src/routes/purchase.japan-parcel.index.tsx` 已实现：输入框 → 300ms debounce → 自动切到「商品」视图 → 触发 `listJapanParcels`。

`src/lib/japan-parcel.functions.ts` (L125-148) 的搜索分支存在 **两个隐性 bug**，会导致"看上去搜不到"：

1. **当前 tab 过滤会盖住搜索结果**：搜索时仍然带上 `tab` 过滤（`purchased` / `delivered` / `problem`）。例如用户在"已采购"页搜一个已签收的包裹的商品名 → 0 结果。
2. **PostgREST `.or()` 字符串注入风险**：搜索词若含 `,` `(` `)` `:`，会破坏 `.or()` 语法导致整个查询报 400；中文虽然安全，但英文/混合输入有概率踩坑。`item_title.ilike.%hello,world%` 这种就会被解析出错。

## 改造方案

### 1. UI：搜索框后面加按钮 + 支持回车

文件：`src/routes/purchase.japan-parcel.index.tsx`

- 在 `<Input>` 同行右侧加一个 `<Button>搜索</Button>`（变体 `secondary`，h-9）。
- 输入框 `onKeyDown`：Enter 时立即提交（绕过 debounce）。
- 新增本地 state `submittedSearch`，按钮/回车点击时 `setSubmittedSearch(search)` 并把 `debouncedSearch` 也同步；listOptions 改用 `submittedSearch` 作为 query key 与请求参数。
- 保留输入时 debounce 自动触发（兼顾现在的体验）。
- 输入框右侧若有内容，显示一个 X 清除按钮（一次性清空 search + submittedSearch）。

### 2. 搜索逻辑修复

文件：`src/lib/japan-parcel.functions.ts` `listJapanParcels`

- **跨 tab 搜索**：当 `data.search` 非空时，忽略 `tab` 过滤里的 `status` / `is_problem` 限制，仅保留 `deleted_at is null`（trash 仍然单独走）。这样用户在任意 tab 搜，都能看到全部匹配。
- **转义搜索词**：构造一个 `escapeForPostgrestOr(s)`，把 `,` `(` `)` `:` 替换/包裹。具体做法：对 ilike 模式用双引号包裹值 → `item_title.ilike."${s}"`（PostgREST 允许用双引号包裹含特殊字符的值），并把 `s` 里的 `"` `\` 转义。`id.in.(...)` 由 UUID 组成，安全。
- 子商品匹配查询同样使用转义后的值。

### 3. 验证

- 改完后到 `/purchase/japan-parcel`：
  - 输入中文商品名 → 点搜索 → 自动切「商品」视图，应能命中无论包裹在哪个 tab。
  - 输入订单号片段 → 回车 → 同上。
  - 输入含逗号的字符串 → 不再 400。
  - 清除按钮 → 回到原始列表，tab 过滤恢复。

## 不改动

- PC / 移动端商品详情、其他路由、count 接口、ViewModeToggle、回收站逻辑。
- Debounce 自动搜索仍保留，按钮只是显式触发入口。
