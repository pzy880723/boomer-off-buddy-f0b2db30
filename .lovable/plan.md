## 问题定位

截图里两条错误说明这次「从有赞同步」两个候选接口都被有赞网关拒了：

1. `youzan.retail.product.standardcategory.get` → **gw 4005 非法的 API**
   意思：**当前授权的这个店铺 / 应用类型根本没有这个接口的权限**。这是零售版专用接口，普通电商版或未开通零售的账号调不到。
2. `youzan.itemcategories.get` → **gw 4007 源 IP 104.23.209.12 非法调用**
   意思：接口本身是能调的，但 **有赞侧强制 IP 白名单**，我们后端出口 IP 没加进有赞应用中心的白名单。

所以之前把「二级类目」加进来其实不是主要问题——**一级都没成功拉回来**，二级更无从谈起。

---

## 修复方案

### 1. 后端：更聪明的接口 fallback + 更清楚的错误呈现

`src/lib/categories.functions.ts → fetchYouzanHqCategories`：

- 按顺序尝试一组接口，能拿到就用，任何一个成功就中断：
  1. `youzan.itemcategories.get`（电商版一级 + children）
  2. `youzan.itemcategories.get.byparentcid`（补二级，parent 逐个拉）
  3. `youzan.retail.product.category.get`（零售版通用类目）
  4. `youzan.retail.product.standardcategory.get`（零售标准类目，仅零售版）
- **区分错误类型**：
  - `gw 4005 / 非法的 API` → 归为「未授权此接口，已跳过」，**不算致命错**，继续尝试下一个。
  - `gw 4007 / 源 IP … 非法调用` → 归为「IP 白名单未配置」，**立即中断**并把出口 IP 直接展示给用户（截图里就是 `104.23.209.12`）。
  - 其它错误 → 常规失败信息。
- 收集所有尝试过的接口结果作为 `notes: Array<{ api, ok, message, count }>`，Preview 弹窗顶部照旧展示。

### 2. UI：把「IP 白名单」这一步做成可操作提示

`src/components/settings/categories-panel.tsx`：

- 顶部原来的失败 toast 太长看不清。改成：
  - 弹窗 / 内嵌 Alert，标题「有赞侧配置未完成」。
  - 正文分两块：
    - **需要在有赞应用中心加白名单的 IP** → 灰底代码框显示，附「复制」按钮。
    - **需要开通/授权的接口** → 列出被 4005 拒绝的接口名，附一行提示「若店铺不是零售版可忽略」。
  - 底部两个按钮：「已完成，重试同步」 / 「稍后」。
- Preview 弹窗顶部 notes 区把每个尝试接口按 ✅ / ⚠️ / ❌ 状态列出来，避免只看到一句聚合失败信息。

### 3. （可选，本轮不做）后端出口 IP 稳定化说明

Lovable Cloud / Cloudflare Worker 的出口 IP 段是浮动的，单个 IP 加白名单可能明天又变。计划里先把当前 IP 完整回显给用户去加白名单让流程跑通；后续如果频繁变，再单独一轮讨论「用固定出口的代理网关」方案，本轮不铺开。

---

## 改动文件

- `src/lib/categories.functions.ts` — 重写 `fetchYouzanHqCategories` 的 fallback 顺序与错误分类；`previewYouzanCategorySync` 返回结构里带 `blockingError: { kind: 'ip_whitelist' | 'no_api' | 'other', ip?, apis? }`。
- `src/components/settings/categories-panel.tsx` — 新增 `<IpWhitelistAlert />` 内嵌卡片；Preview 弹窗 notes 分状态展示。
- 不动数据库、不动其它 tab、不动 `useCategories`。

---

## 验收

1. 再点「从有赞同步」，如果 IP 还没加白名单：页面出现明确 Alert，能一键复制 `104.23.209.12`，并列出被拒的接口。
2. 加完白名单再点「重试同步」：至少一个接口成功，Preview 弹窗顶部 notes 显示每个候选接口的状态（哪个 ✅、哪个因未授权 ⚠️ 跳过）。
3. 若店铺是零售版，能顺利拉到一级 + 二级；若是电商版，走 `itemcategories.get` + `byparentcid` 也能拿到一级 + 二级。
