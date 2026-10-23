# HQ统一门店接入：交付与阻断边界

## 最新腾讯实证与范围收敛（2026-10-23 05:08 UTC）
- 用户腾讯逐个`itemdetail.get`核实美罗城已有14组，display=1，每组32价SKU，库存全0，ERP关联0；其他三店镜像包含真实扣减，不得重置。
- 旧渠道追加路线已不适用于本次任务：不再开发或执行HQ update/create/channel.publish或共享SPU修改；下文商品dry-run/渠道writer步骤仅为历史交付记录，**不得按其继续执行**。
- 商品由用户腾讯端复用目标已有goods，核对448条码/价格后仅补美罗城链接与mirror9999，单组canary后14组；本项目当前只负责会员自动接入/验收，不并发商品同步。
- 用户UI实证HQ与美罗城等级相同：白银无门槛、钻石消费300、黄金500。此为有赞等级，不是ERP free/explorer付费计划；不覆盖计划、权益或资产。
- HQ UI积分100分=1元、all/default=true；branch UI无换算比例、无编辑权限。已确认UI读数不等于官方继承语义已验收；规则writer仍不存在，不换API绕权限。
- 本次仅合并用户实证，不重新跑全库审计或调用有赞；尚无新增资产写入证据，不能宣称全量会员覆盖/资产端到端通过。

## 已实现
- `0105_member_onboarding.sql`：独立service-role任务表；新active分店/身份或总部变更入队，HQ身份/状态变化重验；四个存量分店一次bootstrap。凭据刷新不触发任务。
- `0106_member_onboarding_explicit_grants.sql`：撤销环境默认继承的anon/authenticated表权限；无公共RLS策略，RPC仅service_role。
- `run-member-onboarding.ts`：每次明确一个shop UUID，腾讯固定代理门禁；复用silent token、可信只读SQLite、HQ投影读取；不写余额、操作账本、券或规则。
- `watch-member-onboarding.ts`：PostgreSQL NOTIFY唤醒，启动恢复已有任务，串行子进程；丢失租约仅按其到期时间唤醒，不增加Cloud永久轮询。
- 10分钟租约、revision+claim_token+当前门店身份校验；旧回执失效。变更通知按门店范围写已有system通知，相同连续结果不重发。
- `meluo-standard-single-target.ts`：仅指定美罗城，active标准口径+已有HQ链接，14组×32/448精确约束，组织API独立读取channel；dry-run保存摘要计划且不写数据库/有赞。

## 未完成且保持阻断
1. 官方连锁积分抵扣继承语义和可写规则合同没有核实。worker可以读取两套现有真实接口，但`rulesSupported/rulesEquivalent=false`；没有规则writer，不猜API。
2. 既有POS预览/现金积分路径仍依赖本地wallet。本轮不改支付事务；`posSafe=false`，所以不得通知验收成功。
3. 资产端到端验收不通过本轮人工交易制造；worker总是`assetsEndToEnd=false`，至多未来配置验收，绝不是全部会员资产同步。
4. 单店渠道追加：existing `spu.update` 的`is_partial=1`精确追加语义/权限尚无本轮官方合同实证。脚本canary/all无环境override，返回`official_partial_channel_append_contract_required`，不会执行writes。未交付可执行的canary/full writer。
5. 腾讯服务未部署；本轮没有真实有赞调用、token刷新、会员worker或铺货执行。
6. 用户补充腾讯浏览器美罗城积分编辑提示“当前角色没有操作权限”：不得以silent token可用或更换API绕过此限制；仅正常总部有权限入口可执行，否则blocked等待正常权限配置。当前没有规则writer，阻断保持。
7. 渠道请求构造必须提供已确认官方语义与完整现有渠道证据，保留全部旧渠道并union独立核实的新渠道；完整读回必须含旧渠道与新渠道，否则blocked。不能把215098500直接当渠道号。本轮只修防误用辅助函数，不解除canary/all写门禁。

## 官方与实测证据区分
- silent token：现有源码引用 https://doc.youzanyun.com/detail/API/0/906 ，真实payload使用authorize_type=silent/grant_id/refresh=false。沿用现有函数，不新增版本猜测。
- HQ组织：现有registry https://doc.youzanyun.com/detail/API/0/1793 ，method `youzan.shop.chain.descendent.organization.list/1.0.1`；用户腾讯实测四分店同HQ153242272，美罗城215098500。
- HQ SPU查询：registry https://doc.youzanyun.com/detail/API/0/1789 。渠道部分更新：registry https://doc.youzanyun.com/detail/API/0/1788 ，本轮页面抓取成功，但未获得可确认`is_partial`追加语义的正文，不能冒充官方已确认。
- 官方讨论 https://bbs.youzan.com/thread-689434-1-1.html 与 https://bbs.youzan.com/thread-694113-1-1.html 区分HQ商品库与门店发布；不构成不改共享属性的独立铺货合同。
- 用户腾讯实测：`youzan.scrm.customer.points.rule.list/1.0.0` 四分店rule22919804，每消费1元给1分；`youzan.scrm.pointdecution.get/1.0.0` HQ plugin5=100/plugin6 status1，分店0/status0。read成功不证明继承/实际交易一致，不覆盖HQ。
- 用户仓库实测：HQ `youzan.retail.open.warehouse.query/3.0.0`完整4行，美罗城唯一warehouse_id215098500、code MD00004。姓名电话不留存。

## 腾讯生产步骤
1. 同一共享库已应用0105/0106，**不要重复应用**；先核对迁移journal及4条queued/revision1/attempts0。
2. 将本轮隔离文件合并部署，保留腾讯独立瑕疵、通知与binary/readback文件。无APP API变更。
3. 使用已有腾讯环境的服务器凭据、固定代理、只读SQLite与PG连接；`BOOMER_RUNTIME=tencent`、`MEMBER_ONBOARDING_ENABLED=true`。先单店 `bun scripts/run-member-onboarding.ts d49226af-06b9-4cae-b878-81d580db81f0`。
4. 回读该任务status/reason/checks；当前合理结果是blocked而不是成功。通知必须只在其唯一库位，重复同阻碍不新增通知。不得开启POS本地积分开关。
5. 配置`boomer-member-onboarding.service`前核对真实部署目录、bun路径、环境文件以及service-role PG权限；首次启动读取存量queued，再监听新任务。NOTIFY掉线由supervisor重启补读，失去连接不能当健康。
6. 单店商品只运行 `bun scripts/meluo-standard-single-target.ts dry-run /var/lib/boomer-off/meluo-standard-plan.json`。channel缺失/歧义即blocked；不得手填kdt当channel。
7. 获得官方渠道追加合同后才能实现并审核writer，再执行1组32 canary和同摘要14组全量；每组前后HQ标题/价格/图片/其他渠道不变+美罗城32条码真实回读，不能调用广域hook、offline.release、stock.adjust或图片更新。

## SQL只读验收
```sql
SELECT shop_id,kdt_id,parent_kdt_id,revision,status,reason,attempts,checks
FROM public.member_onboarding_jobs ORDER BY kdt_id;
SELECT has_table_privilege('anon','public.member_onboarding_jobs','SELECT'),
       has_table_privilege('authenticated','public.member_onboarding_jobs','UPDATE'),
       has_function_privilege('authenticated','public.member_onboarding_claim(uuid)','EXECUTE');
SELECT kind,location_id,payload->>'status' AS status,payload->>'reason' AS reason
FROM public.inv_handheld_notifications WHERE ref_type='member_onboarding';
```

隔离回滚断言由PGlite执行，不在真实会员库做功能试写。关闭腾讯worker可停止处理；不删除任务/余额、不停用已登记门店。