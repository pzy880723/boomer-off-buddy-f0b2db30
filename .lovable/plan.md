## 计划：HQ token 候选铺货 method 探测脚本

### 目标
实现一个只用于运维排查的探测入口：用 HQ token 依次尝试 3 个候选 method 的最小 payload，判断哪个 method 在当前有赞授权/版本下可用，并把每个候选的 trace、响应或错误写入 `youzan_sync_logs`。

### 实现内容
1. **新增公共运维路由**
   - 新增 `POST /api/public/hooks/youzan-distribution-probe`
   - 仍沿用现有运维接口的 `apikey` 头校验，避免公开可随便调用。
   - 请求 body 支持：
     - `sku_id`：默认取当前两个测试 SKU 的第一个
     - `branch_shop_id`：默认中信泰富店
     - `dry_run`：默认 `true`，尽量使用最小探测 payload，不做库存变更

2. **准备探测上下文**
   - 读取 HQ 店铺、分店店铺、目标 SKU。
   - 通过已有 `ensureBranchProduct(sku_id, branch_shop_id)` 先确保 HQ SPU/link 存在，拿到 HQ `spu_id` / `spu_code`。
   - 使用 `getHqShop()` + `ensureAccessToken(hq)` 获取 HQ token。

3. **依次尝试 3 个候选 method**
   - `youzan.retail.open.spu.stores.distribute`
   - `youzan.retail.open.spu.publish.to.stores`
   - `youzan.retail.open.product.dispatch`
   - 每个都用 HQ token、短超时、顺序执行。
   - 每个 method 先用最小 payload：优先包含 `kdt_id` / `spu_id` / `spu_code` / `store_kdt_ids` / `target_kdt_ids` 等候选字段组合中最保守的一组；如果返回明显“参数缺失”，同一 method 再补一次等价字段别名 payload，不做无限重试。

4. **写入日志**
   - 每个候选调用前插入/最终更新一条 `youzan_sync_logs`：
     - `action = 'distribution_probe'`
     - `shop_id = branch_shop_id`
     - `kdt_id = 分店 kdt_id`
     - `status = ok/error`
     - `message` 写 method、version、payload 摘要、trace_id、响应 preview
     - `error` 写有赞错误原文
   - 总结果也返回给调用方，便于马上看哪一个可用。

5. **同步更新 API 注册表**
   - 在 `src/lib/youzan-api-registry.ts` 增补 3 个候选 method 的登记项：
     - `token_scope: hq`
     - `business_scene: 门店铺货候选探测`
     - `required_params`
     - `response_keys`
     - `retryable: false`
     - `fire_and_forget: false`
   - 标记为候选/探测用途，避免被误当成主链路正式库存 API。

6. **不改正式主链路**
   - 本次只新增探测脚本和 registry 声明。
   - 不替换 `ensureBranchProduct` 的正式铺货逻辑；等探测结果确认哪个 method 可用后，再单独改正式同步链路。

### 验证
- 调用新路由一次，确认：
  - 返回 3 个候选 method 的逐项结果。
  - `youzan_sync_logs` 有对应日志。
  - 可用 method 能看到 `ok + trace_id`，不可用 method 保留原始错误信息。