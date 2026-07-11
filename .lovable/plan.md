## 目标
打通「HQ SPU 6044984028 → 反查中信泰富分店真实 item_id/sku_id → 库存推 1」全链路，不再让用户去有赞后台开通任何能力；改由代码在多个版本之间自动降级/升级探测。

## 核心原则（新增到 registry）
每个"可能有多个版本"的有赞方法在 `youzan-api-registry.ts` 里登记 `version_candidates: string[]`，调用方按顺序尝试，遇到 `gw 4005 / 未授权 / method not found` 类错误自动切下一个版本；全部失败才抛错。

## 步骤

### 1. `src/lib/youzan-api-registry.ts` 审计与补版本候选
- `youzan.retail.open.online.spu.query`: candidates = `["3.0.0", "1.0.0"]`，token_scope=hq（先 HQ token 反查），body_wrapper=`param`
- `youzan.item.detail.get`: candidates = `["1.0.1", "1.0.0"]`，token_scope=branch
- `youzan.retail.open.spu.query`: candidates = `["3.0.0"]`
- `youzan.retail.open.spu.create/update/delete`: `["3.0.0"]`
- `youzan.item.quantity.update`: `["4.0.0"]`，token_scope=branch，body_wrapper=`param`
- `youzan.shop.chain.descendent.organization.list`: `["1.0.1"]`
- `youzan.retail.open.warehouse.query`: `["3.0.0"]`（新增，未来给库位映射用）
- `youzan.materials.storage.platform.img.upload`: `["3.0.0"]`

### 2. `src/lib/youzan-http.ts` / `youzan.functions.ts` 增加 `callYouzanWithVersionFallback`
- 输入：method 名 + params + token
- 内部：读 registry 的 version_candidates，逐个 `callYouzanApiVerbose`
- 判定"应降级重试"的错误：`gw 4005`、`未授权`、`method not found`、`不支持的版本`、http 404、以及 code 前缀 `40050/40040`
- 记录每次尝试到 `youzan_sync_logs`，最终成功则用命中的版本，全部失败则抛最后一个错

### 3. `probeBranchRealIds` (`src/lib/youzan-sync.functions.ts`) 升级
策略顺序（每步用带版本回退的调用）：
1. HQ token + `retail.open.online.spu.query` 传 `spu_ids=[hqSpuId]`、`kdt_id=branchKdt` → 拿 branch item_id/sku_id
2. Branch token + 同一方法（不传 kdt_id）→ 兜底
3. 有 item_id 后用 branch token + `item.detail.get` 补 sku_id
每步 attempts 里记 `label + version + trace + code + msg`，方便下轮排错。

### 4. `test-publish-with-stock` 测试路由
- `ref_type` 保持 `manual_adjust`（已修）
- 先 reset 相关 `youzan_stock_sync_queue` 记录（status→pending, attempts→0, next_run_at→now）再跑 worker，避免旧失败卡住
- 返回体额外带 `probe_attempts`（包含尝试过的版本）方便一眼看出到底哪个版本走通

### 5. 实测
以 SKU `70a6d177-97e7-4e99-be60-4fdcd2453575`（测试商品）跑 `POST /api/public/hooks/test-publish-with-stock?sku_id=...&qty=1`，按用户要求的 8 段 Markdown 汇报。

## 明确不做
- 不再要求用户开通任何能力
- 不删 SPU 6044984028 / 6046780206（走探测路线，不走重建路线）
- 不改 `inv_apply_movement` / DB 结构

## 风险
若三个版本全部都被网关拒（真的一个都没开），会在 `probe_attempts` 里同时列出 4005 记录，那时才回到"重建 SPU 时一次带上分店渠道"的备选方案；本轮不预先执行。