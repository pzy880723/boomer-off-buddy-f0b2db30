# 附近门店：补齐真实 GCJ-02 坐标（只读核对结论 + 最小方案）

## 只读核对结论（commit 151d0c1d30783f56c4ddcdb263af9833a519020c）
- 数据库：`youzan_shops` 只有 `address`（文本）字段，`inv_locations` 和 `youzan_shops` 都没有纬度、经度、坐标系、城市或营业时间字段。所以数据库里没有任何真实坐标，公开接口返回 null 是正确的，不是数据丢了。
- 正在营业的公开门店有 3 家：温州朔门古港店、BOOMER OFF vintage（中信泰富店）、新天地店。另有一家叫“BOOMER OFF vintage”的门店，它的库位已停用，所以不公开。
- 公开门店接口：`src/routes/api/public/storefront/shops.ts` 的查询只取 `id, shop_name, status, address, image_url` 和库位。`src/server/storefront-shops.server.ts` 里，`PublicShop.latitude/longitude` 的类型固定是 null，`toPublicShop` 第 65–66 行也写死了 null。
- 门店管理：页面是 `src/routes/shop-mgmt.shops.tsx`，有编辑和新建两个表单，目前只能填地址。保存接口在 `src/lib/shops.functions.ts`：编辑用 `updateShopMeta`（按白名单字段更新），新建用 `createShop`。
- 环境：以上结论只针对 Lovable 库。腾讯生产库是独立的迁移副本，我无法读取，不能断定两边一样。本次没有部署腾讯，也没有改动任何东西。

## 最小后端方案（待批准）
1. 增量迁移：在 `youzan_shops` 新增可空字段 `latitude numeric(9,6)`、`longitude numeric(9,6)`，再加 `coord_system text default 'gcj02'` 和 `coord_updated_at`。加检查约束：纬度和经度要么都填、要么都空，并限制在中国范围内（纬度 3–54，经度 73–136），坐标系只允许 `gcj02`。不回填任何数据。
2. 保存接口：`updateShopMeta` 和 `createShop` 接受可选的 `latitude`、`longitude`（最多 6 位小数，必须成对出现），写入时固定坐标系为 gcj02。
3. 管理表单：编辑表单加“纬度 / 经度（GCJ-02，腾讯地图坐标拾取）”两个输入框，由店长或总部人工填真实坐标。系统不根据地址推算，也不填示例坐标。
4. 公开接口：查询加上这两个字段。`PublicShop` 改为 `latitude: number | null`、`longitude: number | null`，再加 `coord_system: "gcj02" | null`。只有纬度和经度都合法时才返回，否则一律返回 null，不猜测。其他字段的白名单不变。
5. 距离计算：附近排序由小程序拿 wx.getLocation（type=gcj02）的结果在本地计算，服务端不接收、不保存用户位置。
6. 测试：补 `storefront-shops.test.ts` 的用例，覆盖有坐标、缺一个坐标、超出范围、坐标系不对等情况，并确认不泄露店长和电话。

## 部署说明
- 迁移和代码改在 Lovable 主线完成。腾讯库要由 Codex 按同一迁移文件执行并发布，之后再由人工录入 3 家店的真实坐标。在那之前，公开接口仍然返回 null。
