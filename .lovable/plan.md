# 门店二维码录入核查报告（只读，2026-10-05 10:41 UTC）

本次只读查询，未改代码、配置、数据，未部署。

## 结论
- 3 家在营门店中，只有新天地店录了二维码（4/5 通道，缺小程序码）。中信泰富店、温州朔门古港店 5 个通道全部没录。
- 新天地店先前的 4 个二维码仍然在，每条记录都有对应的存储文件。
- 其他营销或门店配置里没有找到"录了二维码但没接进打印"的情况。

## 打印接口读的是哪里
- 表：`public.store_qr_configs`。只采用 status=active、存储桶为 `store-qr`、路径为 `{location}/{channel}/{uuid}.png|jpg` 的记录。
- 文件：Storage 私有桶 `store-qr`（public=false），目前一共 4 个文件。
- 通道和数据库里的 purpose 对应关系：wechat→wecom_contact，xiaohongshu→xiaohongshu，dianping→dianping，identify→identify，miniprogram→mini_program。

## 在营实体门店矩阵（Y = 有可用记录且存储文件存在）

| 门店 | location_id | 小红书 | 微信 | 点评 | 鉴定 | 小程序 |
|---|---|---|---|---|---|---|
| 新天地店 | 2df58305-57c1-4792-9920-3c3aa49890bc | Y | Y | Y | Y | 未录 |
| 中信泰富店 | 7111b585-7d7f-4777-b4ae-61ce2b868f78 | 未录 | 未录 | 未录 | 未录 | 未录 |
| 温州朔门古港店 | 8f0d9f93-eb49-40e8-8ec6-65f3770196bb | 未录 | 未录 | 未录 | 未录 | 未录 |

新天地 4 条记录的明细：
- 记录更新时间都是 2026-10-05 06:41:15 UTC。
- 存储文件都是 PNG，上传时间在 06:41:08 到 06:41:14 之间，大小：小红书 299,723 B，微信 63,037 B，点评 304,359 B，鉴定 21,141 B。
- 路径里的通道段（xiaohongshu/wechat/dianping/identify）都和 purpose 对得上，打印接口会采用这 4 条。

## 单列（不算门店）
- 总部仓库 f45dc754-b46b-411a-af7b-28e95ce2b1a0（kind=warehouse，在用）：无二维码记录。
- 已停用 BOOMER OFF vintage 673f674c-55ad-45d8-8175-53f7044d7014：kind=shop、is_active=false，对应有赞总部店 153242272。无二维码记录。

## 其他配置中的二维码
- `store_payment_profiles.qr_mode`：3 家门店都是 dynamic_order。这是收款时按订单动态生成的码，不是可打印的静态码，不需要接进打印。
- `pos_payment_attempts.qr_content`：单笔支付的码内容，不属于门店配置。
- `app_settings`：没有和二维码、微信、小红书、点评、小程序相关的配置项。
- 全库没有其他 qrcode、小程序码或小红书、点评二维码字段。
- 存储里文件名含 qr 的另有 2 个，在 `parcel-item-images` 桶，是采购包裹图片，和门店二维码无关。

## 图片能不能读
- 已确认：4 个存储文件都存在，元数据显示 MIME 是 image/png，大小正常。
- 未确认：没有生成签名链接，也没有下载文件内容，所以没有逐字节确认图片能正常解码。要确认可以在 ERP 打印页预览，或由腾讯侧用接口拉一次。

## 实际查询 SQL
```sql
select now();
select l.id, l.kind, l.name, l.is_active, s.kdt_id, s.shop_name, s.role, s.status
  from inv_locations l left join youzan_shops s on s.id = l.shop_id;
select location_id, purpose, status, image_bucket, image_path is not null,
       split_part(image_path,'/',2) as path_channel, updated_at
  from store_qr_configs order by location_id, purpose;
select c.location_id, c.purpose, o.id is not null as obj_exists,
       o.metadata->>'mimetype', (o.metadata->>'size')::int, o.updated_at
  from store_qr_configs c
  left join storage.objects o on o.bucket_id = c.image_bucket and o.name = c.image_path;
select bucket_id, count(*) from storage.objects where bucket_id ilike '%qr%' group by 1;
select id, public from storage.buckets where id ilike '%qr%' or id ilike '%store%';
select key from app_settings where key ~* 'qr|code|wechat|xiaohongshu|dianping|mini' or value::text ~* 'qr|二维码';
select location_id, qr_mode from store_payment_profiles;
select table_name, column_name from information_schema.columns
 where table_schema='public' and column_name ~* 'qrcode|qr_|_qr|wxacode|mini_program|xiaohongshu|dianping';
select bucket_id, count(*) from storage.objects where name ~* 'qr|qrcode|二维码' group by 1;
```

## 下一步（需要你决定，本次不执行）
- 在 ERP 打印页给中信泰富店、温州朔门古港店上传二维码，并补上新天地店的小程序码。
