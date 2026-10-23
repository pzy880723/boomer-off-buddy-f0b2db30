# 只读核查：拍照上架按钮灰色（toy_board_card）

没有改代码、数据库或配置，也没有部署、建商品或动积分。

## 结论
按钮变灰是 iPhone 端自己的判断造成的，服务端没有拒绝这次提交（也没有收到这次提交）。
- 识别接口 `/api/public/handheld/ai/recognize-item` 从来不返回分类中文名。它只返回编码。
- iOS 的 `hasConfirmedCategory` 要求编码和显示名都非空。识别结果里显示名总是空的，所以只要原生端没有从分类字典补出名字，按钮就一定是灰色。
- 这个分类本身没有问题：`toy_board_card` 已启用，类型 kind=category，中文名“桌游/卡牌”，父分类 `toy_model`“玩具模型”也已启用。
- 没有生成新 op 是正常的：按钮灰着，请求根本没发出去。不需要改取消或幂等保护。

## 字段对照（识别接口返回 → iOS 期望）
| 识别接口返回 | 说明 | iOS 字段 |
|---|---|---|
| `category_code` | 二级分类编码（必有） | categoryCode ✓ |
| `category` | 兼容旧版，值和 `category_code` 相同（是编码，不是中文名） | — |
| `predicted_category_code` | 模型原始预测，可以为 null | — |
| 无 `category_name`、无 `category_path` | 接口合同里没有这两个字段 | category 显示名 ✗ 空 |
| `alternatives[].name` | 填的是 reason，没有 reason 时退回编码，不是分类名 | 不能拿来当名字 |

只有商品列表和详情（`handheld-products.server.ts`、`items.$id.ts`）会返回 `category_name` 和 `category_path`。识别接口不返回。

## 分类字典 `/api/public/storefront/taxonomy`
- 读取 `inv_categories` 中 kind=category 且 is_active=true 的行，按父子关系组成 `primary_categories[].children[]`，每项为 `{code,name}`。
- `toy_board_card` 满足条件，会出现在 `toy_model` 的 children 里：`{code:"toy_board_card", name:"桌游/卡牌"}`。依据是数据库只读查询和代码逻辑，没有实际请求这个线上接口。
- 原生端可以用这份字典（或现有的分类缓存）按编码查出中文名。也可以把“编码在启用的叶分类里”当作确认条件，不再要求识别结果带名字。

## smart-create 真正的服务端门槛
必填：`name`（1–120 字）、`category`（编码）、`price_tier`（0.01–999999.99）。
服务端检查（都发生在提交之前，失败返回 422，不写 op）：
- `assertActiveLeafCategory(category)`：只校验编码是不是启用的叶分类，**不需要也不接收分类显示名**。
- 传了 facet_codes/tags 才校验标签；品牌由 `resolveConfirmedListingBrand` 校验（已匹配即可通过）。IP 为空时 `ip_confirmed` 不影响结果。
- 库位必须启用，否则 404；还有 session（401）和库位授权（403）。

不是硬门槛的项：
- 原图：`image_storage_paths` / `image_url` 都是可选。
- AI 授权和修图就绪：只决定图片计划（ai / raw_declined / pending_consent）。授权未明确或读取失败也照常建商品，由后台 worker 补决。
- `grade`、简介/notes、品牌 ID、特色印章、提示标签：都是可选。

结论：这份草稿（12 字名称、99 元、B 级、有效叶分类编码、品牌已匹配、无 IP、2 张原图）满足服务端所有条件。

## 预提交失败的可观测性
- 拒绝发生在提交前（400/401/403/404/422）时不写 `handheld_smart_create_ops`。服务端也没有专门记录这类拒绝，所以没有持久证据。这次按钮灰着，请求没发出，本来也不会留下记录。
- AI 网关 06:00 到 10:11 UTC 共 144 次请求。抽查最近 30 次，基本都成功（200）。只有 09:30:22 有一次 gemini-3.8-flash 请求被取消（499，耗时 20.7 秒）。这次是不是该草稿的识别或简介请求，无法确认。没有看到与分类名有关的失败。
- 原图上传接口没有持久失败记录可查。草稿里已有 2 个 raw path，说明上传成功了。

## 建议原生侧处理（由你负责）
- `hasConfirmedCategory` 改为：编码非空，并且在本地分类字典里能查到启用的叶分类。显示名用字典补出，不依赖识别接口。
- 如果需要服务端补 `category_name`，只能在识别接口的返回里增加一个可选字段，并更新 OpenAPI 文档。这一步要另外批准，本次不做。
