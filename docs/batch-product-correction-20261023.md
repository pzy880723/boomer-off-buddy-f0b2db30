# 商品批量修订交付 · 2026-10-23

## 本轮最小修订
- 四入口：生成商品卡 / 翻筐乐 / 提示标签 / 特色印章。翻筐乐在同一窗口 radio 加入/移出。
- 商品卡网页入口复用 `buildRecommendationCard` 与原 `generateCardCopy`，只读生成文案。原生端、原图、抠图、AI 提示词/模型、价格标签、导出打印均不改；本轮不新增商品卡打印或保存功能。
- 特色默认 `nochange`，无选择不构建操作；独立 `clear` 才发送 null。替换/清空数量预览均按目标字段计划计算。
- 网页明确选择当前门店/授权库位；全部商品仅浏览，不能批量。总部也必须选择一个有效库位，商品须有该库位库存记录。店长只可选择其授权库位。
- 账号、角色、授权库位、当前库位、tab、搜索输入/查询或翻筐乐筛选变化，清空选择并卸载旧窗口。权限数据每 15 秒刷新；服务端每次提交和每件写入重查角色/库位权限。
- confirmed 请求深拷贝 items/op/version/location；执行时禁止切换操作、关闭窗口或改选项；旧窗口卸载使 late 回执失效。
- retry 仅选原 confirmed 中失败项，绝不采用结果 updated_at 或刷新的商品版本。冲突必须关闭、重新选择并再次确认，才是新操作。
- 401/403 停止剩余项目；请求级异常也停止并清空选择，不能跨店继续。
- CAS 使用原确认 timestamptz，比较保留最多九位小数（纳秒）并归一 Z/+00:00 等价时区，UPDATE 精确匹配 id/status/updated_at；只写目标字段和 updated_at。使用 authenticated/RLS 客户端，未增加授权或改变 RLS。
- SQL RETURNING 返回 `updated_at,featured_stamp,notice_tags,fankuang_override`，逐项核对目标 patch 实际值，核验失败不得报 success。
- batch 新增 `flawed` 保持 skip；没有修改/覆盖腾讯 `product-defect-editor` 或单件 ready 路径。

## 内部网页合同
`batchUpdateProductMarks({data:{location_id,op,items}})`
- `location_id`: 必填 UUID；删除 null/全部授权库位 fallback。
- `items`: 1–200 个 `{id,expected_updated_at}`，重试保持原值。
- `op`: `notice {add,remove}` / `stamp {value}` / `fankuang {value}`，原枚举保持不变。
- 结果仍为逐件 `success/unchanged/skipped/failed`；冲突 returned updated_at 仅作诊断，不作为 retry 版本。
- `getBatchMarkScope`: 服务端当前 userId、角色和可选有效库位。
- `listBatchLocationStocks`: 必填 location_id，服务端授权后分页读取当前库位 SKU/qty，无逐件图片或权限查询。
- `generateWebProductCard`: `{id,location_id}`，会话/角色/库位和库存校验后复用既有只读卡片生成器；没有使用设备 token，也没有改公开 handheld API。

## 验证与边界
- 红测试：总部无库位/外店写、1 微秒版本差异均在修复前失败；确认控制模块尚未实现时报缺失，日志 `/tmp/batch-red.log`。
- 绿测试：4 文件 36/36，包含默认不变/明确清空、deep copy、原版本失败重试、旧回执隔离、401/403 中断、微秒 CAS、RETURNING 目标值核验、老 marks 与商品卡回归。
- 自动 typecheck/build 最新记录 build OK；没有手动执行构建。
- 浏览器 `/inventory/skus` 未登录状态无 pageerror，未暴露批量按钮；本人预览会话获取失败（无匹配应用账号），不能声称登录态流程完成验证。
- 未执行生产商品修改、Youzan 请求、DB 迁移、真实下单或队列重跑；腾讯没有部署。
- 先前 0104 迁移及此前腾讯部署状态不属于本轮新增应用证据。

## 追加版本与总部范围实证
- 当前基线已使用客户端 `version` 调用 CAS，且总部也调用 `skusAtLocations(ids, [location_id])`；新增直接捕获参数的测试锁定这两条规则，没有改回 fresh 版本或宽范围。
- 新增同毫秒 `.123456Z` / `.123999Z` 冲突测试，断言零写入且保留他人特色；CAS 时等价版本字符串也必须原样传客户端确认值。
- 红阶段新增测试 16 pass / 1 fail：六位实现不支持 `.123456000+00:00` 与六位 Z 等价。绿阶段扩展至九位，整秒时区转换与小数部分分离，不对小数 Date.parse/floor。
- 新增总部参数捕获测试：当前 L1 只允许 L1 返回的 SKU；即使总部还有 L2 权限，其他所选商品也 skipped，只有目标 SKU 写入。
- 本轮无数据库迁移或真实商品写入；没有改变公开移动端 API 或腾讯独立文件。