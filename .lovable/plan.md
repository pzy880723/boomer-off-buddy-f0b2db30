## 修 `probeShopChainOrgList`（严格按你 8 条要求）

只改一处文件：`src/lib/integration-capabilities.functions.ts` 里的 `probeShopChainOrgList`（约 561–676 行）。前端 `admin.api-integration.tsx` 的结果面板顺带扩一下用于展示新增字段。

### 具体改动

1. **版本顺序**：`versions = ["1.0.1", "1.0.0"]`，忽略用户在编辑器里选的其他版本，永远 1.0.1 打头。

2. **入参**：每次调用都显式带 `page_num=1, page_size=50`。

3. **分版本解析数组**：
   - `1.0.1` → `data.organization_list`（数组）+ `data.total`
   - `1.0.0` → `data` 本身就是数组（无 total 时用数组长度）

4. **分页循环**：拿到 `total` 后，若 `已收集条数 < total`，继续 `page_num+=1` 直到收齐或跑到第 20 页兜底。所有页合并后再走 `extractBranchNodes`。

5. **两类结果必须分开**：
   - **业务报错**：gw code 非 200 或 `code != 200`（如 `234000001` / `40009`）→ 归为 `attempt.status = "error"`，把 `code / message / errors / trace_id / raw_body` 全部塞进 attempts。
   - **业务成功但空数组**：`code == 200` 且合并后条数为 0 → 归为 `attempt.status = "empty_ok"`（不是错误）。
   - **业务成功有数据** → `attempt.status = "ok"`。

6. **完整字段落地**：每次 attempt 都记录 `{ version, http_status, code, message, errors, trace_id, request_params, raw_body_snippet(<=8KB) }`。前端把这些字段直接铺开显示，不再吞掉 raw。

7. **通过判定**：只要**任一版本** `status == "ok"` 就算通过，返回聚合结果并按现有逻辑写 `sell_channel_id` 到 `youzan_shops`。

8. **"总部下无分店" 结论**：**只有** 1.0.1 和 1.0.0 **两个版本都** `status == "empty_ok"` 才在结论里写"总部下确实没有可查询分店"；只要有任何一个版本 `status == "error"`，结论必须是"接口业务报错，见 attempts 里的 code / message / trace_id"，绝不再冒充"没有组织树"。

### 需要拿到的返回结构示例（用于文档 + 面板）

```text
{
  passed_version: "1.0.1" | "1.0.0" | null,
  conclusion: "ok" | "empty_confirmed" | "business_error" | "auth_error",
  hq: { kdt_id, name },
  aggregated: {
    total_reported: 12,
    fetched: 12,
    nodes: [ ... 全部去重后的 BranchNode ]
  },
  current_branch: { kdt_id, name, found_in_response, sell_channel_id, saved_to_db },
  attempts: [
    { version: "1.0.1", status: "error", http_status: 200,
      code: 234000001, message: "系统异常",
      errors: [...], trace_id: "xxx",
      request_params: { page_num: 1, page_size: 50 },
      raw_body_snippet: "..." },
    { version: "1.0.0", ... }
  ]
}
```

### 前端小改（`src/routes/admin.api-integration.tsx`）

- 在这一行能力的展开面板里，把 `attempts[]` 渲染成一个小表：版本 / 状态 / code / message / trace / raw（点击展开）。
- 顶部大字结论使用 `conclusion` 字段的白话映射：
  - `ok` → 绿色 "已经拿到 N 家分店，中信泰富的渠道号已自动落库"
  - `empty_confirmed` → 黄色 "两个版本都明确返回空数组：总部下确实没有可查询分店"
  - `business_error` → 红色 "接口业务报错（见 attempts）"，附上第一条 error 的 code+message
  - `auth_error`（40009/scope 不足）→ 红色 "总部授权 scope 不够，需要重新授权总部"

### 不动的部分

- `extractBranchNodes` 保持不变（已经足够健壮）。
- `callYouzanApiVerbose` 保持不变；但要确保它把 gw JSON 中的 `errors` 字段透传给上层——如果没有则新增 return 字段 `raw_body`。
- 不新建表；不改 registry。

### 验收方式

我改完后直接用 `invoke-server-function` 触发一次 `probeIntegrationCapability`，把 attempts 数组打印出来给你看。三种可能结果：
- 有分店 → 直接落库 `sell_channel_id`，链路打通
- 报 `234000001` → 你能看到完整 trace_id，我拿去问有赞或走 `shop.configs.get` 继续挖
- 报 scope 不足 → 我生成一个总部重新授权的链接给你（这一步才需要你本人点一下）

要我开工吗？
