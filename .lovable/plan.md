## 改动概览（仅前端 + searchParcels 字段扩展）

### 1. 列表卡片标题改成「首件商品名 等 N 件商品」
- `src/lib/mobile.functions.ts` 的 `searchParcels` select 增加嵌套子表，按 position 升序拿一条：
  ```
  japan_parcel_items(id, item_title_cn, item_title, position)
  ```
  返回时计算 `firstItemName`（取截断的中文名，没中文名退回日文名）和 `itemCount`。
- `src/routes/m.parcels.tsx` 卡片标题渲染规则：
  - `itemCount > 1` → `「首件中文名前 14 字」 等 N 件商品`
  - `itemCount === 1` → 只显示首件名
  - `itemCount === 0` → 显示 `(未填写商品名)`
- 图片仍用 `parcel.item_image_url`（已经是首件图，无改动）。

### 2. 搜索框置顶 + Tab 下移
`m.parcels.tsx` 顶部布局改成：
```text
[ 🔍 搜索框        ]   ← 最上面
[ 待签收 | 已签收 ]    ← 下面
```
（仅 sticky header 内调换两个 div 的顺序）

### 3. 详情页顶部「包裹全量信息」模块
`src/routes/m.receive.$id.tsx` 把现有顶部小卡片扩成完整信息块：
- 第一行：缩略图 + 标题（套用新的「首件名 等 N 件」规则）+ 异常徽标
- 信息网格（label/value 两列，紧凑 11–12px）：
  - 国际单号 / 来源订单号（点按可复制）
  - 状态徽章
  - 卖家
  - 商品合计 ¥ / 国际运费 ¥ / 关税 ¥ / 合计 ¥
  - 重量 g / 件数
  - 购买时间 / 国际付款时间 / 签收时间
  - 备注（如有）
- 数据从 `getJapanParcel().row` 直接读，不需要后端改动；缺失字段隐藏行。

### 4. 到货照片「连续拍摄」
当前 `<input capture="environment">` 系统返回后只能拍一张。改造方案：
- 新增一个 **「连拍」按钮**（picker 弹层里增加第三项 `📷 连拍`）。
- 进入连拍模式后：
  1. 触发隐藏的 capture input；
  2. `onChange` 拿到文件 → 立即上传 → 上传成功后 **自动再次** `captureRef.current?.click()`；
  3. 直到用户在系统相机里按「取消」（input 不返回文件，循环自然结束）或达到 `MAX_PHOTOS = 9`。
- 同时把「拍照」按钮保留为单张模式；「相册选择」保持多选不变。
- 上传过程中右下角悬浮一个 `已拍 X/9 · 点此结束` 的小条，方便用户中途手动结束（设置 `continuousRef.current = false`，下次 onChange 不再续拍）。

### 不动的部分
- 后端表结构、状态字典、RLS、分拣/入库流程：均不动。
- 子商品详情 Sheet、异常流程、签收按钮 disabled 逻辑：均保留。
- 桌面端 `/purchase/japan-parcel/*` 页面：不动。

### 风险与注意
- iOS Safari 在 `capture` input 取消时 `onChange` 不会触发，所以「用户在相机里点取消」=连拍自然停止，不需要额外处理。Android Chrome 行为一致。
- `searchParcels` 嵌套查询会让单次返回稍大，但 `limit ≤ 50`、每条只多两个字符串字段，开销可忽略。
