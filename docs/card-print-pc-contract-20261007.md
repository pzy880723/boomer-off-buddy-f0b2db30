# PC 卡片打印交接 · 2026-10-07

## 现有基础与范围
- `src/components/inventory/sku-detail-shared.tsx`：RFID标签打印，未改。
- `src/routes/inventory.skus.$id.tsx`：商品详情标签入口，未改。
- `src/server/recommendation-card.server.ts`：商品推荐卡文案，未改。
- `src/routes/api/public/handheld/print.store-qr.ts`、`src/server/store-qr-print.server.ts`：原生门店私桶原码、独立用途及旧评价码兼容，未改。
- 项目未发现 PC 预设卡片拼版页、193 预设原图或其清单；不能将 mock-data 商品或 PWA portrait 配置当作卡片预设。

## 新增网页入口
运营 → 卡片打印，`/operations/card-print`。
选择门店 → 载入同域预设清单 → 勾选与数量 → A4 零间距 PDF 预览 → PDF 下载或浏览器打印。
A4 210×297mm，四周最少5mm，底部留校验尺；卡片之间0间距，可旋转拼版。细边框、内侧裁切角标、50mm校验尺。打印选择100%实际大小，无日常单卡/A5导出。

## Codex 静态资源交接（尚未收到实际路径/清单）
网页清单路径输入不预填猜测 URL，只允许当前 ERP 同域 `/...` 路径；最近输入路径保存在浏览器，不保存二维码或权限。
请把原生同一套原图及清单发布在腾讯 ERP 同域；无需数据库配置。网页读取以下 JSON，图片仅 PNG/JPEG 原图：

```json
{
  "version": 1,
  "presets": [
    {
      "id": "stable-preset-id",
      "type_id": "stable-type-id",
      "name": "原生预设名称",
      "category": "qr",
      "enabled": true,
      "orientation": "landscape",
      "width_mm": 90,
      "height_mm": 30,
      "image_path": "/实际资源目录/实际原图.png",
      "channel": "dianping_review",
      "location_id": "2df58305-57c1-4792-9920-3c3aa49890bc",
      "qr_box": { "x_mm": 0, "y_mm": 0, "size_mm": 1 }
    }
  ]
}
```
示例中的资源路径、名称与 qr_box 坐标均为字段说明，不是可部署原稿；必须使用 Codex 原生实际原图路径与原版二维码框坐标。`location_id` 可省略表示跨店模板；二维码每次依当前门店重读。`qr_box` 使用原图左上角为原点的毫米坐标，必须是原版留白二维码区，不得覆盖原图已有其他码。若原生静态图是已合成门店码的成品，请先提供其实际资源合同，不能直接套用空白模板合同。不要据此重绘横版设计。

类别：qr / store_notice / ip / brand / category / import_origin / product。
扫码渠道：xiaohongshu / wechat / dianping_checkin / dianping_review / identify / miniprogram。不支持新预设使用旧 `dianping` 别名。
非扫码卡不得填写 channel/qr_box。独立活动竖海报不放入本清单。
扫码/店铺提示严格仅90×30横卡；enabled=false及历史竖牌即使凭旧ID选择也拒绝。IP/品牌/品类/进口来源按清单保持原尺寸；商品推荐严格60×90。
预览、下载、打印各自重新无缓存读取清单和实时门店授权/原码；停用不能从历史选择重新输出。已下载的离线PDF无法远程撤回。

## API / 权限
公开 handheld `POST /api/public/handheld/print/store-qr` 未改；它必须有设备token，网页不能伪造设备token。
新增内部只读 server function `readCardPrintContext({location_id?})`：网页登录授权，实时 user_roles + user_location_perms，只有有效 shop 门店；HQ可读所有营业门店，员工只能已授权门店。使用既有私桶与300秒原图链接，路径隔离及旧dianping目录仅评价码的语义与 handheld 相同。不返回桶/路径，不写配置、不创建设备，不借码、不输出假码。
无 migration、无新增表/RLS/GRANT、无公开 API 合同变化。

## 发布和验收边界
测试：42/42通过（7项新规则、23项原码、12项推荐卡），tsgo退出0，预览编译记录build OK。合成18张90×30卡输出单张A4，转换图片逐页视觉检查：边界、零间距、50mm尺无裁切或重叠问题。实现审查发现旋转二维码横坐标方向错误，已修正为原版y坐标；旋转码与真实原图仍待实打扫码验收。PDF processing skill用于生成后转图视觉检查，未交付合成测试PDF为门店成品。
网页登录验收未完成：预览无可用当前用户会话，自动会话恢复未成功；实际页面停在认证加载。独立挂载验收因上下文不一致失败，不能当作实际页面错误或通过证据；未改登录代码，未假称网页完整流程通过。
腾讯由 Codex 发布，不使用 Lovable Publish 代替腾讯部署。原生193预设/100类型/7提示数量为用户提供的本地状态，本项目未收到原图清单，不能宣称已同步这193个资源。
需Codex提供同域清单与原图、真实二维码模板坐标后，再验收三店原图、旋转码扫码、193预设数量与一张A4实打50mm尺。浏览器PDF打印行为还需目标PC浏览器实际确认。
