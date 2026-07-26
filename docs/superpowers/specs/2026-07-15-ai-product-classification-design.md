# BOOMER-OFF AI 自动分类与建品设计

日期：2026-07-15
状态：已确认
范围：ERP 网页端、移动网页端、手持设备 API、Supabase 数据层

## 1. 目标

把自定义商品建品流程从“拍照后人工选择分类、填写商品资料”改为：

```text
拍摄 1-6 张商品照片
→ 上传原图
→ AI 识别并从 ERP 分类树选择唯一二级分类
→ 自动填写商品结构化字段
→ 人员只确认售价、数量和目标门店
→ 生成 SKU/EPC/条码、入库并按现有规则上架
```

AI 自动处理品名、一级/二级分类、品牌/厂商/窑口、国家/地区、年代、材质、工艺、器型、颜色、尺寸、成色、功能状态、缺件、商品描述、关键词、建议售价和合规风险。

本期不让人工承担正常分类工作。AI 无法准确判断时仍必须选择系统兜底二级分类，例如 `瓷器 / 产地待确认` 或 `待归类 / AI 低置信度`，建品流程不得因此中断。

## 2. 产品边界

### 2.1 自动完成

- 分类树匹配与二级分类落库
- 商品信息结构化提取
- AI 置信度、备选分类、识别依据和模型版本留痕
- 商品标题和描述生成
- 建议售价生成
- 低置信度自动归入兜底分类
- ERP 网页端、移动网页端和手持设备使用同一识别核心

### 2.2 人员确认

- 最终售价
- 入库数量
- 目标库位和上架门店
- 必要时修改 AI 结果；修改属于纠错能力，不是正常建品必需步骤

### 2.3 本期不做

- AI 自动决定最终售价
- AI 自动创建新分类
- 训练自有视觉模型或微调模型
- 根据一张照片断言文物真伪、品牌真伪或绝对年代

## 3. 分类体系

ERP 只维护两级树。`inv_skus.category` 保存最终二级分类 `code`，一级分类通过 `inv_categories.parent_id` 推导，不重复存储。

### 3.1 一级与二级分类

1. `porcelain` 瓷器
   - `porcelain_japan` 日本瓷器
   - `porcelain_europe` 欧洲瓷器
   - `porcelain_china` 中国瓷器
   - `porcelain_asia_other` 其他亚洲瓷器
   - `porcelain_other_region` 其他地区瓷器
   - `porcelain_origin_unknown` 产地待确认
2. `tableware_other` 其他餐厨器皿
   - 玻璃器皿、金属器皿、搪瓷器皿、木竹器皿、塑料/亚克力器皿、厨房工具
3. `toy_model` 玩具模型
   - 角色人偶/软胶、铁皮发条、车船模型、拼装积木、毛绒布偶、桌游卡牌、扭蛋食玩
4. `audio_media` 唱片影音
   - 黑胶唱片、CD/SACD、磁带/卡带、录像/影碟、乐器/音乐器材、音乐周边
5. `digital_appliance` 数码电器
   - 相机摄像、音响/播放器、游戏机/掌机、通讯设备、电脑/办公、生活小家电、配件耗材
6. `home_decor` 家居陈设
   - 灯具照明、钟表、花器摆件、收纳容器、镜框相框、墙面装饰、小型家具
7. `stationery_publication` 文具书刊
   - 书写工具、桌面文具、本册纸品、书籍、杂志画册、海报印刷、票证/明信片
8. `fashion_wearable` 服饰穿戴
   - 服装、鞋靴、包袋、帽子/围巾、眼镜、首饰、腕表
9. `art_collectible` 艺术收藏
   - 绘画版画、雕塑工艺、民艺手作、徽章奖牌、邮票邮品、钱币/纪念品
10. `daily_misc` 日用杂货
    - 清洁护理、美妆香氛、工具五金、旅行户外、宠物用品、其他生活小物
11. `classification_pending` 待归类
    - `ai_low_confidence` AI 低置信度
    - `new_category_candidate` 新品类候选
    - `compliance_review` 合规待审

二级分类的最终代码由数据库种子迁移统一生成；上面的中文名称是稳定业务口径。

### 3.2 分类与属性分离

分类描述“这是什么”，属性描述“它来自哪里、什么时候、由什么制成、状态如何”。例如：

```text
分类：瓷器 / 欧洲瓷器
国家：英国
品牌：Wedgwood
器型：茶杯碟
年代：约 1970 年代
材质：骨瓷
工艺：描金
```

动漫 IP、具体国家、年代、材质、品牌、风格和成色不得扩展成新的分类层级。

## 4. AI 识别契约

### 4.1 输入

- 1-6 张商品照片，第 1 张为主图
- 当前启用的一级/二级分类树
- 可选店员提示
- 可选已有商品字段

建议照片顺序：正面、背面、底款/铭牌、瑕疵、配件、尺寸参照。

### 4.2 输出

AI 返回严格 JSON：

```json
{
  "category_code": "porcelain_europe",
  "confidence": 0.94,
  "alternative_categories": [],
  "name": "Wedgwood 描金骨瓷茶杯碟",
  "brand": "Wedgwood",
  "maker": null,
  "origin_region": "欧洲",
  "origin_country": "英国",
  "era": "约 1970 年代",
  "material": ["骨瓷"],
  "craft": ["描金"],
  "object_type": "茶杯碟",
  "colors": ["白色", "金色"],
  "dimensions": null,
  "condition_grade": "A",
  "functional_status": "不适用",
  "missing_parts": [],
  "description": "...",
  "keywords": ["英国骨瓷", "描金", "茶杯碟"],
  "suggested_price_cny": 399,
  "compliance_flags": [],
  "evidence": ["底款可见 Wedgwood 字样", "器型为配套杯碟"]
}
```

### 4.3 服务端规则

- AI 只能返回当前启用的二级分类代码。
- 返回未知、停用或一级分类代码时，服务端自动改为相应兜底分类。
- 瓷器产地不明确时使用 `porcelain_origin_unknown`，不得猜测日本或欧洲。
- 总体置信度低于 `0.75` 时使用 `ai_low_confidence`。
- 命中合规风险时使用 `compliance_review`，同时保留原始预测分类。
- AI 调用失败最多重试两次；仍失败时返回兜底结果，不中断建品。
- 每次识别保存模型、提示词版本、分类树版本、原始结果和归一化结果。

## 5. 数据设计

### 5.1 `inv_categories`

沿用现有表和 `parent_id`。新增种子迁移，将旧扁平分类保留为停用项，避免破坏历史数据；新商品只能选择启用的二级分类。

### 5.2 `inv_skus`

新增：

- `attributes jsonb not null default '{}'`
- `category_source text`：`ai`、`manual`、`import`、`legacy`
- `category_confidence numeric`
- `classification_status text`：`auto_classified`、`fallback`、`corrected`
- `ai_suggested_price numeric`

最终分类仍写入现有 `category` 字段。

### 5.3 `inv_sku_classifications`

新增识别审计表：

- `id`
- `sku_id`，允许在商品创建前暂为空
- `request_id`
- `category_code`
- `confidence`
- `alternative_categories jsonb`
- `attributes jsonb`
- `evidence jsonb`
- `raw_result jsonb`
- `normalized_result jsonb`
- `model`
- `prompt_version`
- `taxonomy_version`
- `status`
- `corrected_category_code`
- `corrected_by`
- `created_at`、`updated_at`

## 6. 代码边界

### 6.1 动态分类服务

新增纯服务端分类加载和校验模块。所有 AI 入口通过该模块获得分类树，删除前端和手持接口中写死的分类枚举。

### 6.2 AI 核心

新增单一 `recognizeProductFromImages` 核心：

- 构造动态分类提示词
- 调用 Lovable AI Gateway
- 校验结构化输出
- 应用置信度和合规兜底规则
- 写入识别审计记录

ERP 的 `recognizeSkuFromPhotos` 和手持端 `aiRecognizeItem` 只做鉴权、输入转换和结果映射。

### 6.3 建品

- ERP 网页端拍照后自动填充所有 AI 字段。
- 移动网页端共用同一组件。
- 手持端 `SmartCreateReq` 接收识别 `request_id` 和结构化属性。
- `createCustomSku` 和 `items/smart-create` 在事务边界内保存分类来源、置信度、属性，并把审计记录关联到新 SKU。
- 价格和数量仍由人员提交。
- 现有有赞上架、库存移动、编码和打印链路保持不变。

## 7. 失败处理

| 场景 | 行为 |
|---|---|
| AI 网关超时 | 指数退避重试两次，随后进入 AI 低置信度 |
| 分类树为空 | 阻止识别并记录配置错误，不创建无分类商品 |
| AI 返回不存在分类 | 自动使用 AI 低置信度 |
| 瓷器产地不明 | 自动使用产地待确认 |
| 多张图互相矛盾 | 保留 warning/evidence，使用低置信度或产地待确认 |
| 识别成功但商品创建失败 | 保留 request_id，客户端重试建品，不重复调用 AI |
| 重复提交 | 沿用手持端 client_op_id 幂等机制 |

## 8. 测试和验收

### 8.1 单元测试

- 分类树只输出启用二级分类
- 日本/欧洲瓷器映射正确
- 未知分类自动兜底
- 低置信度自动归类
- 合规风险优先于普通分类
- AI JSON 缺字段时仍能产生合法结果
- 旧分类兼容迁移

### 8.2 API 测试

- ERP 多图识别
- 手持设备 storage path 多图识别
- 识别后 smart-create 自动写入属性和审计
- AI 失败不要求人工分类
- 重试不重复创建 SKU 或增加库存

### 8.3 线上验收样品

至少使用以下真实照片：

- 日本瓷器底款清晰/不清晰各一件
- 欧洲瓷器底款清晰/不清晰各一件
- 铁皮玩具
- 黑胶唱片
- 老相机或播放器
- 无法识别的普通杂货

验收标准：所有样品均能完成建品；确定样品分类正确；不确定样品进入对应兜底分类；商品字段和识别审计可在 ERP 查看。

## 9. 发布顺序

1. 数据库迁移和分类种子
2. 动态分类与 AI 核心测试
3. ERP 网页端智能新建
4. 手持 API schema、OpenAPI 和 SDK
5. 手持端调用联调
6. 腾讯云部署
7. 真实样品验收和旧商品批量重分类
