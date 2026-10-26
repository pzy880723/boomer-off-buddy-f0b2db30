# 只读核对结果：其他门店是否混入别店自定义商品（不改代码、不写、不部署）

## 1. 四家启用分店与库位（youzan_shops + inv_locations，一店一库位）
| 门店 | kdt_id | warehouse_code | 库位 id |
|---|---|---|---|
| 中信泰富店 | 187395218 | MD00001 | 7111b585-7d7f-4777-b4ae-61ce2b868f78 |
| 温州朔门古港店 | 178113306 | MD00002 | 8f0d9f93-eb49-40e8-8ec6-65f3770196bb |
| 新天地店 | 212291308 | MD00003 | 2df58305-57c1-4792-9920-3c3aa49890bc |
| 徐汇美罗城店 | 215098500 | MD00004 | e393a259-8318-44ec-b0b1-7be3d885436e |
| 总部（hq） | 153242272 | 无 | 673f674c-55ad-45d8-8175-53f7044d7014 |

youzan_shops 没有 is_active 字段，“启用”只能按 role=branch 判断。

## 2. 跨店保留意图
- inv_skus.default_shop_ids（uuid[]）：自定义品（sku_scope='custom'）指向任何一家店的数量都是 0。
- 正库存的自定义品（inv_stocks.qty>0）：新天地 79、美罗城 6、中信泰富 3、温州 0；其中有 default_shop_ids 的都是 0。
- 结论：数据库里没有任何明确的“跨店保留”标记。合法归属只能是正库存所在的那家店（inv_stocks.location_id → inv_locations.shop_id）。

## 3. 进行中的调拨（stock_transfers）
- 相关字段：kind、status、from_shop_id/to_shop_id、from_location_id/to_location_id、from_sku_id/to_sku_id、from_youzan_item_id/to_youzan_item_id、qty、shipped_at、received_at、youzan_sync_status。
- 全表只有 1 条记录：kind=custom、status=received，同店（from_shop_id=to_shop_id）。
- 目前没有在途的跨店调拨，不需要排除。执行前请 Codex 再查一次：status 不是 received/cancelled、且 from_shop_id≠to_shop_id 的记录，目标店要排除。

## 4. youzan.retail.open.offline.spu.query 3.0.0（只看代码，没有响应日志）
- 注册表（youzan-api-registry.ts:520-533）写的是 token_scope=hq、scope=hq，说明是“查询总部或指定 warehouse_code 下的门店商品”。代码只用总部 token 加 warehouse_code 调用，没有用分店 token 调用的先例，所以分店 token 能否列出商品无法确认。
- 请求参数（server.ts:122-138）：page_no（≥1）、page_size（1-50，默认 20）、show_display、warehouse_code、name_or_sku_no、item_ids；另有 page_no×page_size≤3300 的限制。
- 响应解析（server.ts:236-258）：只读 data.offline_spus[]（item_id、title、spu_no、is_display、sku_models[].sku_id）。代码不读 total 或任何分页总数字段，所以总数字段名代码里查不到，只能看第一次真实响应。单店超过 3300 件时这个接口列不全，需要按 name_or_sku_no 或 item_ids 分段。

## 边界
- 上面的数据库结果只说明我方记录的状态，不能排除在有赞那边发生的串店（美罗城就是例子）。最终证据以 Codex 逐件精确 item_code 调用 itemdetail.get（kdt/channel=1）为准。
- 撤销候选 = 某店 channel=1 有该商品，但该店库位在 ERP 没有正库存，且没有在途调拨到这家店。标准品（unlimited）和已清理的 44 件不在范围内。
- 本轮没有任何写入、部署或代码改动。
