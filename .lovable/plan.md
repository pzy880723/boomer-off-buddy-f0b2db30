# 生产导出能力确认 + 取数计划（本轮不执行任何生产变更）

## 0. 已核实事实（本轮只读查询得到）

- 生产项目 ref：`sxddfcoiaboqcmeviykl`（由 Lovable Cloud 控制面返回，非仓库猜测），托管区 `ap-northeast-1`，实例规格 Tiny，未暂停。
- Storage 现状（实时统计）：
  - `parcel-item-images`（公开）1041 个对象 / 894 MB
  - `sku-listing`（私有）14 / 14 MB
  - `sku-raw`（私有）3 / 4.4 MB
  - `shop-images`（私有）2 / 353 kB
  - `domestic-bulk-attachments`（私有）0
  - `domestic-order-screenshots`（私有）0
  - 合计约 1060 个对象 / ~913 MB。

## 1. 能力确认（直接回答你的 5 个问题）

**a) Lovable 能否直接生成完整数据库备份（roles.sql / schema.sql / data.sql）？**
不能。本项目是 Lovable Cloud 托管后端，我这边可执行只读 SQL 与迁移，但明确禁止执行 `pg_dump` / `pg_dumpall` 或整库导出，也拿不到 `postgres` 超级用户口令。因此 `roles.sql` 与跨 schema（`auth`/`storage`/`vault`/`cron`/`net`/`supabase_functions`）的 `schema.sql`、`data.sql` 无法由我生成。

**b) 能否创建临时只读数据库凭据？**
不能。Lovable Cloud 不向用户或 Agent 暴露数据库密码、service role key、JWT secret，也没有自助创建临时只读角色/凭据的入口。这一项必须由项目所有者向 Lovable 官方申请。

**c) Storage 全量导出的推荐方式？**
Lovable Cloud UI 没有整桶导出按钮。可行顺序：
1. 首选：向 Lovable 支持申请一次性、限期的 Storage S3 兼容访问（endpoint 形如 `https://<ref>.supabase.co/storage/v1/s3`，region 与项目一致），拿到临时只读 access key 后用 `rclone`/`mc mirror` 直接同步到腾讯云 COS。
2. 备选（无需任何密钥、可立刻做）：`parcel-item-images` 是公开桶，占全部体量的 98%（894 MB / 1041 个对象），可用公开 URL 清单直接批量拉取；剩余 19 个私有对象体量极小（~19 MB），可由所有者在控制台逐个下载或用短期 signed URL 批量取。
3. 我可以生成对象清单 CSV（bucket / path / size / mime / created_at / updated_at / metadata），供腾讯云侧做拉取与校验基线——这属于只读，随时可做。

**d) 必须由项目所有者手动点击/申请的步骤**
1. Lovable 面板 → Cloud → Advanced settings → **Export data**：导出 `public` 业务数据（这是唯一自助的数据导出通道，只支持导出、不支持导入）。
2. 提交 Lovable 支持工单（https://lovable.dev/support 或 support@lovable.dev），申请：
   - `pg_dumpall --roles-only` 产物；
   - 覆盖 `public/auth/storage/vault/realtime/cron/net/supabase_functions/extensions` 的 `pg_dump --schema-only --no-owner`；
   - `auth.*` / `storage.*` 的 data 段（`public` 部分可用面板导出替代）；
   - 临时只读直连凭据 **或** Storage S3 临时只读 key（二选一或都要）；
   - 切割日 PITR 快照并保留 ≥7 天；
   - 是否可提供导出期只读窗口。
3. 凭据交付渠道：要求 Lovable 通过其私密通道下发，你收到后直接录入腾讯云 SSM/KMS，**不要粘贴到本项目聊天、仓库、commit 或文档**。本项目已有的 14 个 Secret 只能看到名称，值需你在腾讯云侧重新录入。

**e) 平台能力受限时，最短、不中断线上业务的替代流程**
```text
T-7d  提交支持工单（roles/schema/auth+storage data/S3 临时 key/PITR 快照）
T-3d  面板 Export data 导出 public 业务数据（只读，不影响线上）
T-3d  我生成 storage 对象清单 CSV → 腾讯云侧先做一次全量 Storage 预拉取（公开桶可零凭据完成）
T-1d  腾讯云侧用 schema.sql + 首轮 data 做恢复演练与行数校验
T-0   只读窗口（预计 15–30 分钟）：
      1) 暂停 4 个 pg_cron 任务（youzan-sync / youzan-stock-worker /
         channel-sync-worker / commerce-release-expired）
      2) 前端挂维护提示（只读）
      3) 取增量：public 业务表二次导出 + storage 增量 mirror
      4) 腾讯云侧导入 + 校验（行数、序列值、RLS 118 条、RPC 34 个）
      5) DNS/入口切换
T+0   Lovable 侧保持 7 天可回滚（PITR 快照 + 原实例不删）
```
若最终拿不到 `auth.*` 备份与原 JWT Secret，则 4 个 ERP 员工账号需在切换后各重登一次（bcrypt 密码哈希可迁移，session/refresh_token 必然失效）；消费者侧已在腾讯云自建 Auth，不受影响。

## 2. 本轮不做的事

不修改任何代码、schema、数据、Secret、发布状态；不生成迁移；不输出任何密码、access key、JWT secret、service role key。

## 3. 建议下一步（等你点头再执行，仍为只读）

- 生成 `lovable-cloud-storage-manifest.csv`（1060 条对象清单，含 size/mime/时间戳）作为腾讯云拉取与校验基线；
- 生成 `parcel-item-images` 公开桶的可直拉 URL 清单，让腾讯云侧现在就能把 98% 的对象体量预同步完；
- 生成一份「支持工单申请项 + 交付校验清单」，你可直接粘贴到 Lovable 工单。
