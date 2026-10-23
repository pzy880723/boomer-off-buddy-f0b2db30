# HQ统一门店接入：交付与阻断边界

## 05:24 POS安全适配与腾讯回执
- 本轮红测先行（缺适配模块/空body helper失败），绿测87逻辑+2真实handler隔离+14 PGlite SQL隔离=103通过。入口测试使用mock授权/DB，不是真实会员交易验收；无新增迁移，腾讯尚未部署本轮窄diff。
- 用户腾讯回执：ownership/tokens/rules/HQ指纹通过，真实任务仍`blocked/pos_local_wallet_path`，`assetsE2E=false`。总部10/10镜像刷新通过；商品448条渠道9999与其他三店1344变体stock未变为用户独立实证。本轮不重复查询线上，不更新任务或资产；Node22编译CLI/5分钟REST dispatcher由用户部署中。
- `run-member-onboarding.ts`经受测`readHqDeductionPolicy`发送官方空JSON对象`{}`，删除`query_request`；分页请求保持原规则。此前文档该字段为历史错误，按本节纠正。
- `points-policy.server.ts`不再读取`pos_points_rules`或本地wallet积分，包括缺RPC fallback。仅调用现有可信resolver、`productionProjectionStore.read`和当前active分店/HQ一致的队列checks；不调用refresh/recordBalance/recordFailure/有赞接口。只读规则指纹来自checks，不能推导转换率或启用ERP付费方案。
- `hq-read-only.ts`使redemption恒disabled、`available_points:null`、`max_points/applied_points/discount_amount=0`；独立`hq_read_only`展示`balance/last_synced_at/hq_kdt_id/policy_fingerprint/configuration_mirror_verified`，始终`assets_end_to_end:false/redemption_supported:false`。可信映射缺失、客户/HQ/yz身份不一致、未成功或当前失败时balance为null，旧失败晚于新成功才算当前失败；不制造余额0、不读分店getter。
- POST `/api/public/pos/discounts/preview`与POST `/api/public/pos/sales`完成既有鉴权（sales再验证班次本人）后，非零`points_to_redeem`立即409，`code=pos_points_read_only`，不执行商品报价查询/销售事务。零积分保持原报价及v2交易路径。已有v3 SQL保留但这两个入口不再能到达；不改变支付/库存/优惠/退货事务、不改`posSafe=false`。其他具有数据库直接执行权限的调用者不由此应用层防护覆盖，不能声称数据库旧钱包已删除或全系统实用验收通过。
- 正积分历史提交的重试也会被入口拦截，不应当重发新订单；应走已有销售查询/恢复入口只读确认原交易。通知仍沿用原blocked去重，无成功状态更改。

### 真正积分扣退后续（本轮未实现、未调用）
1. 核实有赞连锁HQ正规授权、扣分/返还官方合同及POS实用继承；禁止单店开关setter替代。
2. 复用可信身份和现有积分operation账本，设计订单/扣退operation_key、租约/幂等、未知回执仅对账、成功读回；不另建分店余额。
3. 支付成功/取消/退款与扣分/返还的补偿及部分退款精确额度，重试不能重复扣退，先隔离测试再正式授权canary；不把投影余额当扣款锁。
4. 旧本地wallet事务调用彻底收敛及直接RPC权限审查、真实授权设备端到端验证后才另行修改posSafe和资产验收状态。本轮没有迁移、开关或真实扣退/发券。

## 组织分页窄修（2026-10-23 05:17 UTC）
- 用户腾讯只读canary实证：组织1.0.1空请求返回161400200“页码必须大于0”。read显式接收params并JSON序列化，组织请求从`{page_num:1,page_size:50}`开始逐页读；HQ getter仍显式传`query_request:"{}"`。
- 1.0.1返回采用有赞官方论坛历史成功响应合同：`data.organization_list/total/page_num/page_size`（https://bbs.youzan.com/thread-691040-1-1.html）；registry的`organizations`不是已验证合同，不用递归猜字段。该论坛不是本轮腾讯实时回包，当前官方文档页仅取得外壳；腾讯复验需确认同一响应schema，若不同则阻断，不猜路径。
- 校验页码/页大小回显、稳定total、逐页预期条数、唯一kdt与parent正整数；累计条数等于total才返回完整列表，最多100页。重复节点/重复页、非法schema、短页未完整、后续失败、total变化或达到上限均阻断，不依据第一页命中提前通过。只保留两个身份字段，不保存原始响应或PII。
- 读完再核实唯一目标和parent；仅修查询，不重置或伪造首次`worker_unavailable`任务结果，不新增迁移。腾讯窄更新脚本与`src/server/member-organizations.ts`后正常重新验收，仍沿用租约/版本/通知去重。
- 商品448linked/448published、仓库与渠道库存及32canary队列done/last_error空是用户腾讯独立实证；本轮没有商品操作。sidecar尚未启用，会员自动接入未通过，POS/资产验收阻碍保持。

## HQ-only合同修订（2026-10-23 05:14 UTC）
- 已通过网页读取核实官方正文 https://doc.youzanyun.com/v2/doc/cloud/token/HzjQw3M2tiDUOEkXcmKcl2XTncc.md ：getter支持微商城单店、零售单店及D/L/L高级版总部，**不支持连锁分店**。此前分店0不作为关闭或不同规则依据，也不要求分店写同规则。
- `run-member-onboarding.ts`仅在组织核实后使用HQ token调用抵扣getter，官方请求`query_request:"{}"`；不再调用分店抵扣getter，也不调用setter。分店token刷新回读仍保留用于授权检查。
- `hq-points-policy.ts`核对返回kdt为HQ、商品范围枚举、列表、默认开关、唯一plugin5比例正数及plugin6状态/门槛/上限枚举。`rulesSupported`依有效HQ schema判定；`rulesEquivalent`仅指分店绑定同一HQ镜像，**不表示原生POS继承已验证**。
- SHA256策略指纹基于HQ id、scope及规范化语义字段；去重排序商品id，排除更新时间、凭据、PII与资产；不擅自把plugin5的数值换算成UI单位。
- 增量函数仅扩展队列checks安全投影：`hqPolicyKdtId`、`hqPolicyScope=youzan_chain_hq`、`hqPolicyFingerprint`、`hqConfigurationMirrorVerified`、`youzanPosInheritanceVerified=false`。租约/版本/目标HQ校验沿用；旧worker回执兼容，不重新入队，不修改资产/方案。
- 有效schema可明确记录“HQ配置镜像已核对”，但当前`posSafe=false`，结果仍`blocked/pos_local_wallet_path`。`youzanPosInheritanceVerified=false`和`assetsEndToEnd=false`明确表示“有赞POS实用未验收”；不得发成功通知。若未来本地安全通过但原生继承未验收，仍blocked，使用既有`assets_not_end_to_end_verified`原因，不新增误导的分店差异。
- 腾讯先沿用当前部署，窄更新上述脚本/纯校验/worker及新finish函数；共享库本轮应用后不要重复迁移。保持用户Node22编译与REST有界扫描部署方式，不启用旧Bun/PG watcher。
- 用户报告商品14组448SKU已完成MD00004/channel9999真实回读，最终关联验收进行中；本轮不复查/操作商品，不作独立验收声明。

## 集成更新（用户腾讯报告，2026-10-23 05:11 UTC；未独立复验）
- 用户已通过正常浏览器积分目录读取并保存官方正文：https://doc.youzanyun.com/v2/doc/cloud/token/VzWAwKP1NilN2Hkiy4ncOhLVnuc.md 。其`youzan.ump.pointdeduction.update.openstatus/1.0.0`仅开关，需后台先配置规则，支持店铺类型仅“微商城单店”；禁止当作连锁规则同步接口。
- 腾讯无Bun、DATABASE_URL或PGHOST，原PG NOTIFY watcher当前不可部署。用户保持已交付服务端/SQL不动，计划独立采用Node22编译run-member-onboarding.ts及腾讯systemd有界REST扫描：每5分钟，仅queued/过期lease，四店串行。该方案尚未作为已部署/验收记录，不是Cloud轮询。
- 不获取PG凭证、不改依赖/修图、不重启主ERP。下文Bun/PG watcher步骤被此次腾讯部署方案取代，不应继续要求获取PG凭证。
- 商品由用户腾讯端复用已有goods及MD00004仓库单据：32SKU canary已通过；32条直接quantity被拒任务经实际warehouse+channel9999回读后fenced归档；其余13组进行中，不能写成448SKU全部完成。旧商品dry-run已不需要，不再执行。
- 以上为用户提供进度，本轮不审计全库、不写代码/数据库、不执行任何商品同步或资产操作。

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
1. 本段为前次交付记录：最新HQ-only合同与动态schema门禁见顶部05:14修订；原生POS实用继承仍未验收，没有规则writer。
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