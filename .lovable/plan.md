## 目标

把 `/admin/api-integration` 每张能力卡片改成真正的「左右两栏」布局，并把接口方法名 + 版本号合并成一个整段输入框（例如 `youzan.retail.open.stocksupply.relaiton.query.1.0.0`），不再拆成两格。

## 布局调整（`src/routes/admin.api-integration.tsx`）

每张卡片改成 `grid-cols-1 lg:grid-cols-2`（大屏严格左右各占一半，小屏才回退到上下）：

```text
┌────────────────────────────┬────────────────────────────┐
│ 左：能力说明                │ 右：测试面板                │
│  • 能力名称                 │  • 选择测试店铺            │
│  • 一句话讲清做什么         │  • 参数输入区              │
│  • 当前接口全名（只读展示） │  • 【立即测试】按钮        │
│  • 授权方式 / 作用范围      │  • 最近一次测试结果        │
│  • 备注                     │    （状态 / 耗时 / 响应）  │
│  • 【编辑】【文档】【恢复】 │                            │
└────────────────────────────┴────────────────────────────┘
```

- 左栏顶部：能力中文名 + 「已通过 / 未测 / 失败」大徽章。
- 左栏中部：需求说明（原 `requirement`）+ 备注。
- 左栏底部：一行只读展示当前用的接口全名，例如 `youzan.trades.sold.get.4.0.4`，方便一眼核对。
- 右栏就是原来的测试面板，纵向排布：门店选择 → 参数 → 测试按钮 → 结果。

## 接口全名合并成一个输入框

现在编辑弹窗里 `method` 和 `version` 是两格，改成一格「接口全名」：

- 新增一个字段 **接口全名**，占位符示例：`youzan.retail.open.stocksupply.relaiton.query.1.0.0`
- 保存时前端拆分：以最后两个 `.` 之前作为 `method`，最后 `major.minor` 作为 `version`。
  - 例：`youzan.trades.sold.get.4.0.4` → method=`youzan.trades.sold.get`，version=`4.0.4`
  - 例：`youzan.retail.open.spu.create.3.0.0` → method=`youzan.retail.open.spu.create`，version=`3.0.0`
- 校验：必须匹配 `^[a-z0-9.]+\.\d+\.\d+\.\d+$`，不符合就红字提示「格式应为：接口名.主版本.次版本.修订版本，例如 youzan.trades.sold.get.4.0.4」，保存按钮禁用。
- 底层数据库仍然拆开存 `method` + `version`（`updateIntegrationCapability` 签名不动），只是 UI 合并展示与输入。
- 编辑弹窗其它字段保持中文标签不变（作用范围 / 授权方式 / 备注）。

## 文档链接

保留上一版的「按接口名搜索有赞文档中心」策略，但用合并后的接口全名去掉版本号那部分再拼搜索关键词，命中率更高。

## 不改动

- 后端 `src/lib/integration-capabilities.functions.ts` 及数据库 schema 不动。
- 参数字段（`PROBE_FIELDS`）保持中文标签，不合并、不拆分。
- 侧边栏、路由结构、其它页面不变。

## 验收

1. 桌面浏览器打开 `/admin/api-integration`，每张卡片肉眼可见的左右两栏（大屏左右各占一半）。
2. 点【编辑】弹窗里只有一个「接口全名」输入框，粘贴 `youzan.retail.open.stocksupply.relaiton.query.1.0.0` 能正常保存。
3. 保存后左栏「当前接口」立刻显示新的全名，测试仍能正常调用。
