# 打印预设与门店扫码卡只读核查结果（本轮未改任何文件，腾讯未部署）

## 1. PC 网页入口
- 页面：`src/routes/operations.card-print.tsx`（ERP「运营 → 卡片打印」）。
- 门店与二维码：`src/lib/card-print.functions.ts` `readCardPrintContext`，登录校验 + `user_roles` / `user_location_perms` 门店隔离，读 `store_qr_configs` 并对私有桶 `store-qr` 签 300 秒链接；路径必须属于本店（`src/lib/card-print/qr-policy.ts`）。
- 目录：`src/lib/card-print/contract.ts` `loadCatalog` 只读**同域** `/print-presets/print-presets.json`（原生数组格式）+ `/print-presets/qr-templates.json`（每店每渠道一条）。
- **PC 不直接读** `boomeroff.com/downloads/erp-print-presets/manifest.json`。该云目录是对象格式（schema/version/base_url/presets，含 sha256 字段），而 PC 解析器是严格数组且不接受 sha256，直接指向会解析失败。PC 走腾讯同域静态文件，项目仓库里没有 `public/print-presets/`。

## 2. 云目录现状（只读下载，289 条）
- 尺寸：80×120 101 条、90×30 100 条、80×40 88 条；分类 IP 183 / 品类 81 / 店铺提示 15 / 品牌 6 / 进口来源 4。
- 「手办与模型」已有完整三件套：`portrait-new-33`(80×120)、`shelf-12`(90×30)、`hook-shelf-12`(80×40)，pairID 都是 `portrait-new-33`，**不要重复新增**。
- 迪士尼：只有子 IP（米奇 ip-11、小熊维尼 ip-13、史迪奇、玩具总动员，各有三种尺寸），**没有通用「Disney 迪士尼」总类**，需要新增 80×120 + 90×30 + 80×40（挂钩卡同在这个目录里，按现有 `hook-` 前缀补齐）。
- 翻翻筐有惊喜：云目录里没有，需要新增 90×30 + 80×120（分类用「店铺提示」）。

## 3. 门店扫码卡接口与美罗城配置（只读 SQL）
- 渠道 → 表 `store_qr_configs.purpose`：wechat→wecom_contact、xiaohongshu→xiaohongshu、dianping_checkin→dianping_checkin、dianping_review→dianping_review（历史 dianping 只当评价码）、identify、miniprogram→mini_program。
- 中信泰富 / 新天地 / 温州：五项都已启用，图片路径都属于本店。
- **徐汇美罗城店：store_qr_configs 0 行**，所以不管模板做成什么样，都会显示缺码，不能出卡。
- 文案：服务端打卡卡标题是「收藏打卡送冰箱贴」，评价卡是「诚邀您点评 / 欢迎分享真实体验」，评价卡没有赠送文案。

## 4. 哪些只放静态文件就能生效，哪些要改代码或数据
| 项目 | 手机端（云目录） | PC 网页 |
|---|---|---|
| Disney 总类 3 尺寸、翻翻筐 2 尺寸 | 只加静态文件 + 更新 manifest 即可 | 还要同步到腾讯同域 `print-presets.json`（数组格式，字段去掉 sha256）及对应 PDF/PNG；不用改代码 |
| 美罗城微信/小红书/点评打卡/点评评价 90×30 模板 | 静态模板 | 在 `qr-templates.json` 加 4 条：`location_id`=美罗城 UUID，路径 `/print-presets/qr-templates/{uuid}-{channel}.pdf/.png`，带 qr_box；不用改代码 |
| 美罗城真实二维码 | 两端都要 | **必须写数据**：super_admin 在现有扫码卡管理界面（`print/store-qr` 保存接口）上传四个码，写到 `store_qr_configs` 和私有桶。这是业务数据写入，本轮没做 |
| 不需要 | 改数据库结构、改 AI / 上架 / 支付服务 | — |

## 下一步（需你授权）
1. Codex 交付原件后，同步腾讯同域 PC 静态目录（不在 Lovable 仓库）。
2. 由总部管理员通过现有界面上传美罗城四个二维码；上传后我可以只读回查本店路径。
