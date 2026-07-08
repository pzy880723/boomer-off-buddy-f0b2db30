## 现状诊断

分店同步链路本身已通（HQ SPU 已建 + `sell_channel_ids` 追加 + `item.detail.get` 反查 branch_item_id + `item.quantity.update/4.0.0` 覆盖库存）。分店看不到图片是因为 **SPU 建的时候图片就没进有赞**，不是分店同步的锅。

两处问题：

1. **`buildSpuCreateAttempts` 用错字段名**（`src/lib/youzan-sync.functions.ts` L850-854）
   目前塞的是 `images: [url]` + `photo_url: [{url}]`。`youzan.retail.open.spu.create/3.0.0` 官方要的是：
   - `pic_url`：主图（string）
   - `spu_pic_list` / `spu_img_list`：图组（array of string 或 `[{img_url}]`）
   `images` / `photo_url` 会被有赞静默丢弃，所以 SPU 建成功但无图。

2. **`uploadImageToYouzanMaterial` 用错参数**（L681-724）
   `youzan.materials.storage.platform.img.upload/3.0.0` 官方参数是 `image_url` **不带 `image_type`** 或走 base64 `image` 字段。目前虽然带 `image_type: 0` 通常不会报错，但需要顺便把返回值 walk 更宽（`content.url` / `data.url`），避免 CDN 拿不到就走原始外链——但有赞对外链域名有白名单，原始外链常常再被丢弃。

3. **两个测试 SKU 已经建了 SPU 但没图**，只 relist 不够——需要用 `spu.update/3.0.0` 回填图片，或先删再建。

---

## 计划

### Step 1 · 修正 `buildSpuCreateAttempts` 图片字段
文件：`src/lib/youzan-sync.functions.ts` 的 `buildSpuCreateAttempts`
- 把 `base.images` / `base.photo_url` 换成：
  ```
  base.pic_url = sku.image_url
  base.spu_pic_list = [sku.image_url]
  base.spu_img_list = [{ img_url: sku.image_url }]  // 兜底别名
  ```
- 第二个 attempt 也同步改成 `pic_url`。

### Step 2 · 收紧 `uploadImageToYouzanMaterial`
- 去掉 `image_type: 0`（该字段属于分类上传，非必填反而可能触发校验）。
- `walk()` 增加 `content` / `data` / `attachment_url` 键。
- 上传失败时打 warn 日志到 `youzan_sync_logs`（现在只 console.warn 看不到）。

### Step 3 · 新增 `spu.update` 图片回填分支
在 `ensureHqSpuLink` 里，如果 `existingRemote.spuId > 0` 且本地 sku 有 image，追加一次 `youzan.retail.open.spu.update/3.0.0`：
```
{ spu_id, pic_url: cdnImage, spu_pic_list: [cdnImage] }
```
这样已经建好的 SPU 也能补图，不需要删了重建。

### Step 4 · 扩展 `/api/public/hooks/youzan-relist`
- Body 新增 `refresh_images?: boolean`（默认 true）。
- 在 `ensureBranchProduct` 之后，对每个 sku 显式调一次 `spu.update` 回填图片，并把响应 preview 加进 `steps`。
- 这样一次 `curl` 就能：删旧 SPU → 建新 SPU（带图）→ 追加分店 → 反查 branch id → 推库存 = 1 → 确认图片进 CDN。

### Step 5 · 手工触发一次 relist
在本轮改动完部署后，你（或我在 build 模式下）执行一次：
```
curl -X POST https://.../api/public/hooks/youzan-relist \
  -H "apikey: <SUPABASE_PUBLISHABLE_KEY>" \
  -H "content-type: application/json" \
  -d '{"delete_existing":true,"target_stock":1}'
```
返回里会带 `spu.create` / `spu.update` / `quantity.update` 三段 `trace_id`，用于定位有赞侧是否收到图片。

---

## 技术备注（可跳过）

- 有赞零售 SPU 图片字段以 `pic_url` 为主，`spu_pic_list` 是数组。文档里门店端 `item.detail.get` 返回也是 `pic_url`，所以本地 `youzan_items.pic_url` 与之对齐。
- `materials.storage.platform.img.upload` 上传失败大多因为源 URL 需要跨境或非 https；退化到原始外链时有赞门店端会显示空图。所以 Step 2 的日志比 Step 1 更重要——一旦上传持续失败，需要考虑先落到我们自己的 Supabase Storage 公开桶再转手。
- `spu.update` 覆盖 `sell_channel_ids` 时必须传全量分店 kdt 列表，Step 3 里沿用现有 `collectSellChannelKdtIds(scope='custom')` 结果。

---

## 不动的部分

- 分店库存推送链路（`pushStockToYouzan` + `item.quantity.update/4.0.0`）保持不变。
- Registry 表结构不动，只在注释里补一行"图片走 pic_url / spu_pic_list"。
- Webhook / 订单同步 / 售后同步不动。
