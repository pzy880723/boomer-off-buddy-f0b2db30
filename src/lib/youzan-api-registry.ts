// ============================================================
// 有赞 API 全量登记表（Audit 版 · 2026-07)
// ------------------------------------------------------------
// 用途：
//  1. /youzan「API 能力体检」按此清单对每家门店逐个探测；
//  2. 出现 [gw 4005] 时直接告诉运营去有赞后台开哪个中文能力名；
//  3. 后续新增有赞接口时，先在这里登记再写调用代码。
//
// 增强字段（用户 2026-07 Audit）：
//  - token_scope      : hq | branch | both — 明确该 method 应该用哪个 token
//  - business_scene   : 一句话业务用途（跟 spec 对齐，方便代码 review）
//  - required_params  : 必传字段清单（帮 code review 判断入参完整性）
//  - response_keys    : 常见响应里我们真的读的字段（帮解析代码保持一致）
//  - retryable        : 网络/超时错误时是否允许自动重试
//  - fire_and_forget  : 是否允许 fire-and-forget（不 await 结果）
//  - notes            : 踩过的坑 / 版本迁移备注
// ============================================================

export type YzApiScope = "hq" | "branch" | "both";

export type YzApiFeature =
  | "auth"
  | "shop_info"
  | "category"
  | "group"
  | "material"
  | "product_master"
  | "product_online"
  | "stock_sales"
  | "stock_warehouse"
  | "trade"
  | "refund"
  | "logistics"
  | "member"
  | "coupon";

export const YZ_FEATURE_LABELS: Record<YzApiFeature, string> = {
  auth: "授权 / Token",
  shop_info: "门店 · 员工 · 库位",
  category: "零售类目 (retail category)",
  group: "商品分组 (item group / tag)",
  material: "素材 · 图片",
  product_master: "总部商品库 SPU",
  product_online: "门店在售商品",
  stock_sales: "门店销售库存 (覆盖式)",
  stock_warehouse: "实物仓库存 (进出存)",
  trade: "交易 / 订单",
  refund: "售后 / 退款",
  logistics: "物流 / 发货",
  member: "会员 / 客户",
  coupon: "优惠券 / 营销",
};

export type YzApiSpec = {
  key: string;
  method: string;
  version: string;
  /** 版本回退候选（按顺序尝试，遇到 4005/未授权/method not found/404 自动降级）。不填则只用 version。 */
  version_candidates?: string[];
  scope: YzApiScope;
  /** Audit 新增：Token 层级 —— 决定用 HQ token 还是分店 token */
  token_scope: YzApiScope;
  feature: YzApiFeature;
  capability_name: string;
  doc_url: string;
  in_use: boolean;
  required: boolean;
  /** 只读探测参数；null = 写入类接口，体检时跳过实调，只显示"最近推送成功时间" */
  probe: { params: Record<string, string | number | boolean> } | null;
  /** 用于 UI 展示的中文说明 */
  description: string;
  /** Audit 新增字段 */
  business_scene: string;
  required_params: string[];
  response_keys: string[];
  retryable: boolean;
  fire_and_forget: boolean;
  notes?: string;
};

/** 生成 trades.sold.get 需要的最近 7 天窗口 */
function recentWindow() {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  return { start_created: fmt(start), end_created: fmt(end) };
}

export const YOUZAN_API_REGISTRY: YzApiSpec[] = [
  // =====================================================
  // 授权
  // =====================================================
  {
    key: "auth.token",
    method: "auth/token",
    version: "silent",
    scope: "both",
    token_scope: "both",
    feature: "auth",
    capability_name: "自用型应用授权 (client_credentials / silent)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/906",
    in_use: true,
    required: true,
    probe: { params: {} },
    description: "获取每家门店 access_token；所有接口的前置条件。",
    business_scene: "HQ / 分店分别换取自用型 access_token",
    required_params: ["kdt_id"],
    response_keys: ["access_token", "refresh_token", "expires"],
    retryable: true,
    fire_and_forget: false,
    notes: "HQ token 与分店 token 必须分开存储，永远不要混用。",
  },

  // =====================================================
  // 门店 / 员工 / 库位
  // =====================================================
  {
    key: "shop.get",
    method: "youzan.shop.get",
    version: "3.0.0",
    scope: "both",
    token_scope: "both",
    feature: "shop_info",
    capability_name: "查询店铺基本信息",
    doc_url: "https://doc.youzanyun.com/detail/API/0/17",
    in_use: true,
    required: true,
    probe: { params: {} },
    description: "读取当前 kdt_id 的店铺名/类型，作为 ping 用。",
    business_scene: "Token 可用性 / ping",
    required_params: [],
    response_keys: ["shop", "id", "name", "type"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "shop.chain.descendent.organization.list",
    method: "youzan.shop.chain.descendent.organization.list",
    version: "1.0.1",
    version_candidates: ["1.0.1", "1.0.0"],
    scope: "hq",
    token_scope: "hq",
    feature: "shop_info",
    capability_name: "连锁 · 查询总部下门店组织",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1793",
    in_use: true,
    required: false,
    probe: { params: {} },
    description: "拿门店组织树、kdt_id、角色 + sell_channel_id，用于修正 SPU 销售渠道。",
    business_scene: "映射 local_shop_id ↔ kdt_id ↔ sell_channel_id",
    required_params: [],
    response_keys: ["organizations", "kdt_id", "role", "sell_channel_id"],
    retryable: true,
    fire_and_forget: false,
    notes:
      "对齐 spec：优先此接口取门店树，而不是 retail.shop.list.query。/api/public/hooks/youzan-fix-channel 用它拿门店 sell_channel_id。",
  },
  {
    key: "retail.shop.list.query",
    method: "youzan.retail.shop.list.query",
    version: "1.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "shop_info",
    capability_name: "连锁 · 查询门店列表 (旧)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1793",
    in_use: true,
    required: false,
    probe: { params: { page_no: 1, page_size: 1 } },
    description: "旧版门店列表，descendent.organization.list 不可用时兜底。",
    business_scene: "兜底门店枚举",
    required_params: ["page_no", "page_size"],
    response_keys: ["shops"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "retail.open.warehouse.query",
    method: "youzan.retail.open.warehouse.query",
    version: "3.0.1",
    version_candidates: ["3.0.1", "3.0.0", "1.0.1", "1.0.0"],
    scope: "both",
    token_scope: "both",
    feature: "shop_info",
    capability_name: "查询仓库 / 库位",
    doc_url: "https://doc.youzanyun.com/detail/API/0/3365",
    in_use: true,
    required: false,
    probe: { params: { page_no: 1, page_size: 1 } },
    description: "查询这家店有哪些仓库/库位，确认以后实物库存相关操作能落到正确位置。",
    business_scene: "门店链路检查：确认 warehouse_code / warehouse_name",
    required_params: ["page_no", "page_size"],
    response_keys: ["warehouses", "warehouse_code"],
    retryable: true,
    fire_and_forget: false,
    notes: "用户指定文档页 API/0/3365；链路检查会自动测试 3.0.1 / 3.0.0 / 1.0.1 / 1.0.0。",
  },

  // =====================================================
  // 类目 / 分组
  // =====================================================
  {
    key: "retail.open.category.query",
    method: "youzan.retail.open.category.query",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "category",
    capability_name: "连锁 · 查询零售商品类目",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1795",
    in_use: false,
    required: true,
    probe: { params: { page_no: 1, page_size: 1 } },
    description: "spu.create 需要的 category_id 从这里查。",
    business_scene: "SPU 创建前拿零售类目 ID",
    required_params: ["page_no", "page_size"],
    response_keys: ["categories", "category_id", "name"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "category.listchildren",
    method: "youzan.category.listchildren",
    version: "1.0.0",
    scope: "both",
    token_scope: "both",
    feature: "category",
    capability_name: "查询叶子类目",
    doc_url: "https://doc.youzanyun.com/detail/API/0/109",
    in_use: false,
    required: false,
    probe: { params: {} },
    description: "新版类目字段 leaf_category_id 场景下备用。",
    business_scene: "新版叶子类目",
    required_params: [],
    response_keys: ["categories"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "itemcategories.tags.get",
    method: "youzan.itemcategories.tags.get",
    version: "3.0.0",
    scope: "both",
    token_scope: "both",
    feature: "group",
    capability_name: "查询店铺分组 (tag)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/108",
    in_use: true,
    required: false,
    probe: { params: {} },
    description: "拉取一/二级分组，用于对账；不作为主链路阻塞点。",
    business_scene: "查询已有分组",
    required_params: [],
    response_keys: ["tags", "id", "name"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "item.base.search",
    method: "youzan.item.base.search",
    version: "1.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "group",
    capability_name: "查询总部渠道商品",
    doc_url: "https://doc.youzanyun.com/v2/doc/cloud/token/JRAWwM0wZiLTgCkUnUUcWSPYn8c.md",
    in_use: true,
    required: true,
    probe: null,
    description: "按 ERP 商品编码解析有赞总部渠道 item_id，禁止把零售 SPU ID 或分店 item_id 用于分组覆盖。",
    business_scene: "ERP 分类覆盖有赞商品分组前的商品身份校验",
    required_params: ["kdt_id", "channel", "item_codes"],
    response_keys: ["items", "item_id", "channel_item_id", "item_code", "title"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "item.group.create",
    method: "youzan.item.group.create",
    version: "1.0.0",
    scope: "both",
    token_scope: "both",
    feature: "group",
    capability_name: "创建商品分组",
    doc_url: "https://doc.youzanyun.com/v2/doc/cloud/token/TDmDwTf2Pi97eQknGbZcZt5Yngf.md",
    in_use: true,
    required: false,
    probe: null,
    description: "按 ERP 分类层级创建有赞商品分组；分组 ID 与有赞官方类目 ID 严格分开。",
    business_scene: "ERP 分类同步为有赞商品分组",
    required_params: ["request.kdt_id", "request.channel", "request.title"],
    response_keys: ["group_id"],
    retryable: false,
    fire_and_forget: false,
    notes: "版本固定 1.0.0；只创建商品分组，禁止写入商品 category_id。",
  },
  {
    key: "item.group.search",
    method: "youzan.item.group.search",
    version: "1.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "group",
    capability_name: "查询一级商品分组",
    doc_url: "https://doc.youzanyun.com/v2/doc/cloud/token/Nf48wDdxoigV5AkqlXPcaG32nOh.md",
    in_use: true,
    required: true,
    probe: null,
    description: "同步前读取有赞一级商品分组，按 channel 分开对账。",
    business_scene: "ERP 分类分组 dry-run 与正式同步",
    required_params: ["request.kdt_id", "request.channel", "request.page_no"],
    response_keys: ["group_id", "title"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "item.group.children.get",
    method: "youzan.item.group.children.get",
    version: "1.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "group",
    capability_name: "查询二级商品分组",
    doc_url: "https://doc.youzanyun.com/v2/doc/cloud/token/M9l9wOnjdisKwjkpdO6cqUd9nnh.md",
    in_use: true,
    required: true,
    probe: null,
    description: "按一级分组读取二级商品分组，避免同名子分组串到错误父级。",
    business_scene: "ERP 二级分类分组同步",
    required_params: ["request.kdt_id", "request.group_id", "request.channel", "request.page_no"],
    response_keys: ["group_id", "title"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "item.itemgroup.get",
    method: "youzan.item.itemgroup.get",
    version: "1.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "group",
    capability_name: "查询商品分组归属",
    doc_url: "https://doc.youzanyun.com/v2/doc/cloud/token/HGAlwFXqeidftokhZi6c4wkGn1g.md",
    in_use: true,
    required: true,
    probe: null,
    description: "覆盖前保存原分组快照，覆盖后再次读取验证。",
    business_scene: "商品分组同步审计与回滚证据",
    required_params: ["request.kdt_id", "request.channel", "request.item_id"],
    response_keys: ["item_id", "group_id"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "item.itemgroup.update",
    method: "youzan.item.itemgroup.update",
    version: "1.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "group",
    capability_name: "覆盖商品分组归属",
    doc_url: "https://doc.youzanyun.com/v2/doc/cloud/token/E4zjwg6OgiTxjUkDu30cH4z5niZ.md",
    in_use: true,
    required: true,
    probe: null,
    description: "operate_type=3 覆盖商品分组，每次最多 10 个商品；不修改有赞官方类目。",
    business_scene: "ERP 分类覆盖有赞商品分组",
    required_params: [
      "kdt_id",
      "channel",
      "item_ids",
      "group_ids",
      "operate_type",
    ],
    response_keys: ["success"],
    retryable: false,
    fire_and_forget: false,
  },

  // =====================================================
  // 素材 / 图片
  // =====================================================
  {
    key: "materials.storage.platform.img.upload",
    method: "youzan.materials.storage.platform.img.upload",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "material",
    capability_name: "上传商品图片素材",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1233",
    in_use: false,
    required: false,
    probe: null,
    description: "商品图片必须先上传到有赞素材库，拿 img.yzcdn.cn 域名回填。",
    business_scene: "SPU / 图片同步前置",
    required_params: ["image"],
    response_keys: ["url", "image_id"],
    retryable: true,
    fire_and_forget: false,
    notes: "禁止把 ERP 外链图片直接塞给 spu.create。",
  },

  // =====================================================
  // 总部商品库 SPU
  // =====================================================
  {
    key: "retail.open.spu.query",
    method: "youzan.retail.open.spu.query",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "product_master",
    capability_name: "连锁 · 查询总部 SPU 商品库",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1789",
    in_use: true,
    required: true,
    probe: { params: { page_no: 1, page_size: 1 } },
    description: "总部商品库 SPU 主数据；查重按 spu_codes（数组），不许按名字。",
    business_scene: "SPU 存在性校验（唯一键 spu_code）",
    required_params: ["page_no", "page_size"],
    response_keys: ["spus", "spu_id", "spu_code", "product_name"],
    retryable: true,
    fire_and_forget: false,
    notes: "查重唯一键：spu_code / sku_code，禁止按 name 匹配。",
  },
  {
    key: "retail.open.spu.create",
    method: "youzan.retail.open.spu.create",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "product_master",
    capability_name: "连锁 · 创建总部 SPU",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1788",
    in_use: true,
    required: true,
    probe: null,
    description: "写入类：ERP 新建 SKU 时自动登记 HQ SPU；体检不实调。",
    business_scene: "本地 SKU → 有赞总部 SPU 首次登记",
    required_params: [
      "name",
      "spu_code",
      "unit",
      "retail_price",
      "category_id",
      "offline_create",
      "is_up_offline",
    ],
    response_keys: ["spu_id", "spu_code"],
    retryable: false,
    fire_and_forget: false,
    notes:
      "必须传 offline_create=true + is_up_offline=true，否则只建总部 SPU 不铺到分店。sell_channel_ids 决定门店可见范围。",
  },
  {
    key: "retail.open.spu.update",
    method: "youzan.retail.open.spu.update",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "product_master",
    capability_name: "连锁 · 更新总部 SPU",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1788",
    in_use: true,
    required: false,
    probe: null,
    description:
      "修正 sell_channel_setting_request 到门店渠道 (is_partial=1 + sell_channel_ids=[门店渠道])；也用于追加分店渠道。",
    business_scene: "把 HQ SPU 的销售渠道设置成分店门店渠道（而不是网店渠道）",
    required_params: ["spu_id", "sell_channel_setting_request"],
    response_keys: ["spu_id"],
    retryable: false,
    fire_and_forget: false,
    notes:
      "sell_channel_id 从 shop.chain.descendent.organization.list 的门店节点拿；开错到网店渠道会导致分店 item.detail.get 反查不到。/api/public/hooks/youzan-fix-channel 用此接口修正。",
  },
  {
    key: "retail.open.spu.delete",
    method: "youzan.retail.open.spu.delete",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "product_master",
    capability_name: "连锁 · 删除总部 SPU（运维）",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1788",
    in_use: true,
    required: false,
    probe: null,
    description: "仅运维/清理接口，正常业务链路禁用。",
    business_scene: "清理误建 SPU",
    required_params: ["spu_codes"],
    response_keys: [],
    retryable: false,
    fire_and_forget: false,
    notes: "只允许 /youzan-cleanup 与 /youzan-relist 使用；主链路禁止调用。",
  },
  {
    key: "retail.open.spu.stores.distribute",
    method: "youzan.retail.open.spu.stores.distribute",
    version: "1.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "product_online",
    capability_name: "连锁 · SPU 门店铺货候选探测",
    doc_url: "https://doc.youzanyun.com/",
    in_use: false,
    required: false,
    probe: null,
    description: "候选写入类：探测 HQ SPU 是否可通过此 method 铺到门店。",
    business_scene: "门店铺货候选探测，不是正式主链路",
    required_params: ["spu_id", "store_kdt_ids"],
    response_keys: ["success", "is_success", "trace_id"],
    retryable: false,
    fire_and_forget: false,
    notes: "仅 /api/public/hooks/youzan-distribution-probe 使用；确认可用前禁止接入正式同步。",
  },
  {
    key: "retail.open.offline.spu.query",
    method: "youzan.retail.open.offline.spu.query",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "product_online",
    capability_name: "连锁 · 查询门店商品信息",
    doc_url: "https://doc.youzanyun.com/detail/API/0/294",
    in_use: true,
    required: true,
    probe: { params: { page_no: 1, page_size: 1, show_display: 1 } },
    description: "查询总部或指定 warehouse_code 下的门店商品，建立 item_id / sku_id 渠道映射。",
    business_scene: "首次导入门店商品映射、铺货后回查和人工恢复绑定",
    required_params: ["page_no", "page_size"],
    response_keys: ["offline_spus", "item_id", "sku_models", "sku_id", "sku_no"],
    retryable: true,
    fire_and_forget: false,
    notes: "page_no * page_size 不得超过 3300；sell_stock_count 已废弃，禁止用于库存对账。",
  },
  {
    key: "retail.open.offline.spu.release",
    method: "youzan.retail.open.offline.spu.release",
    version: "3.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "product_online",
    capability_name: "连锁 · 发布总部商品到分店",
    doc_url: "https://doc.youzanyun.com/detail/API/0/209",
    in_use: true,
    required: true,
    probe: null,
    description: "将总部商品库商品正式发布到选定分店，并返回门店 item_id / sku_ids。",
    business_scene: "HQ SPU 首次发布到分店；发布成功后保存渠道映射并回查",
    required_params: [
      "category_id",
      "unit",
      "price",
      "title",
      "picture",
      "spu_code",
      "sku_center_code",
      "sub_kdt_status_param",
      "stocks",
    ],
    response_keys: ["item_id", "sku_ids"],
    retryable: false,
    fire_and_forget: false,
    notes: "首次发布专用；已发布商品走 update/库存接口。金额字段同时存在元和分，必须字段级转换。",
  },
  {
    key: "retail.open.spu.publish.to.stores",
    method: "youzan.retail.open.spu.publish.to.stores",
    version: "1.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "product_online",
    capability_name: "连锁 · SPU 发布到门店候选探测",
    doc_url: "https://doc.youzanyun.com/",
    in_use: false,
    required: false,
    probe: null,
    description: "候选写入类：探测 HQ SPU publish-to-stores 铺货能力。",
    business_scene: "门店铺货候选探测，不是正式主链路",
    required_params: ["spu_id", "store_kdt_ids"],
    response_keys: ["success", "is_success", "trace_id"],
    retryable: false,
    fire_and_forget: false,
    notes: "仅 /api/public/hooks/youzan-distribution-probe 使用；确认可用前禁止接入正式同步。",
  },
  {
    key: "retail.open.product.dispatch",
    method: "youzan.retail.open.product.dispatch",
    version: "1.0.0",
    scope: "hq",
    token_scope: "hq",
    feature: "product_online",
    capability_name: "连锁 · 商品分发候选探测",
    doc_url: "https://doc.youzanyun.com/",
    in_use: false,
    required: false,
    probe: null,
    description: "候选写入类：探测 product.dispatch 是否是当前授权可用的门店铺货接口。",
    business_scene: "门店铺货候选探测，不是正式主链路",
    required_params: ["spu_id", "kdt_id"],
    response_keys: ["success", "is_success", "trace_id"],
    retryable: false,
    fire_and_forget: false,
    notes: "仅 /api/public/hooks/youzan-distribution-probe 使用；确认可用前禁止接入正式同步。",
  },
  {
    key: "retail.open.online.spu.query",
    method: "youzan.retail.open.online.spu.query",
    version: "3.0.0",
    version_candidates: ["3.0.0", "1.0.0"],
    scope: "branch",
    token_scope: "hq",
    feature: "product_online",
    capability_name: "连锁 · 查询门店在售 SPU",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1790",
    in_use: true,
    required: true,
    probe: { params: { page_no: 1, page_size: 1 } },
    description:
      "分店已上架的 SPU；用于对账门店 storefront 是否真的可见。默认 3.0.0，降级到 1.0.0。",
    business_scene: "铺货后校验分店 storefront 可见 / 反查分店 item_id",
    required_params: ["page_no", "page_size", "kdt_id"],
    response_keys: ["spus", "spu_id", "item_id"],
    retryable: true,
    fire_and_forget: false,
    notes: "版本走 version_candidates 自动回退，不需要人工在有赞后台切能力。",
  },
  {
    key: "item.detail.get",
    method: "youzan.item.detail.get",
    version: "1.0.1",
    version_candidates: ["1.0.1", "1.0.0"],
    scope: "branch",
    token_scope: "branch",
    feature: "product_online",
    capability_name: "查询单个商品详情",
    doc_url: "https://doc.youzanyun.com/detail/API/0/28",
    in_use: true,
    required: true,
    probe: null,
    description: "反查分店真实 item_id / sku_id（必须传 item_id/alias，不接受 spu_id）。",
    business_scene: "quantity.update 前反查分店 item_id / sku_id",
    required_params: ["node_kdt_id", "item_id"],
    response_keys: ["item_id", "sku", "sku_id"],
    retryable: true,
    fire_and_forget: false,
    notes:
      "必须用【分店 access_token】+ node_kdt_id=分店 kdt_id + item_id=分店 item_id；spu_id 会报 [301000002]。",
  },

  {
    key: "item.common.search",
    method: "youzan.item.common.search",
    version: "1.0.0",
    scope: "branch",
    token_scope: "branch",
    feature: "product_online",
    capability_name: "商品列表检索 (辅助)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/24",
    in_use: false,
    required: false,
    probe: { params: { page_no: 1, page_size: 1 } },
    description: "detail.get 拿不到时做兜底定位。",
    business_scene: "兜底定位分店商品",
    required_params: [],
    response_keys: ["items", "num_iid"],
    retryable: true,
    fire_and_forget: false,
  },

  // =====================================================
  // 门店销售库存（覆盖式 · 主链路）
  // =====================================================
  {
    key: "item.quantity.update",
    method: "youzan.item.quantity.update",
    version: "4.0.0",
    scope: "branch",
    token_scope: "branch",
    feature: "stock_sales",
    capability_name: "商品库存覆盖 (4.0.0)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/45",
    in_use: true,
    required: true,
    probe: null,
    description:
      "写入类：分店 token + 分店真实 item_id/sku_id + stock_num_str 全量覆盖；体检不实调。",
    business_scene: "把 ERP 本地库存覆盖同步到分店 storefront",
    required_params: ["kdt_id", "item_id", "sku_id", "channel", "stock_num_str"],
    response_keys: ["is_success"],
    retryable: true,
    fire_and_forget: false,
    notes:
      "废弃 retail.open.stock.adjust 用作分店销售库存。库存是全量覆盖，不是增量。无 SKU 商品时 sku_id 传 spu_id。",
  },

  // =====================================================
  // 实物仓库存（进出存 · 非主链路）
  // =====================================================
  {
    key: "retail.open.stock.adjust",
    method: "youzan.retail.open.stock.adjust",
    version: "3.0.0",
    scope: "both",
    token_scope: "hq",
    feature: "stock_warehouse",
    capability_name: "连锁 · 实物仓库存调整",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1791",
    in_use: false,
    required: false,
    probe: null,
    description:
      "禁止用于普通门店销售库存推送；只允许进出存 / 仓库盘点场景（需要 warehouse_code、source_order_no、order_items[].sku_code）。",
    business_scene: "仓库实物盘点 / 进出存（禁止用于门店销售库存）",
    required_params: ["warehouse_code", "source_order_no", "order_items"],
    response_keys: ["is_success"],
    retryable: false,
    fire_and_forget: false,
    notes:
      "禁止用于普通门店销售库存推送——主链路必须走 youzan.item.quantity.update/4.0.0。误用会报 [123000104] 不支持的库存更新类型:3。",
  },

  // =====================================================
  // 交易 / 订单
  // =====================================================
  {
    key: "trades.sold.get",
    method: "youzan.trades.sold.get",
    version: "4.0.4",
    scope: "branch",
    token_scope: "branch",
    feature: "trade",
    capability_name: "查询已卖出交易 (订单列表)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/70",
    in_use: true,
    required: true,
    probe: { params: { page_no: 1, page_size: 1, ...recentWindow() } },
    description: "按 kdt_id 拉取分店订单，供仪表盘与首次同步/定时兜底扫描。",
    business_scene: "订单列表定时补拉",
    required_params: ["page_no", "page_size", "start_created", "end_created"],
    response_keys: ["trades", "tid", "total_results"],
    retryable: true,
    fire_and_forget: false,
    notes: "spec 要求版本 4.0.4；本仓库历史遗留 3.0.0 已在 audit 中升级。",
  },
  {
    key: "trade.get",
    method: "youzan.trade.get",
    version: "4.0.2",
    scope: "branch",
    token_scope: "branch",
    feature: "trade",
    capability_name: "查询单笔订单详情",
    doc_url: "https://doc.youzanyun.com/detail/API/0/71",
    in_use: false,
    required: true,
    probe: null,
    description: "消息推送后延迟 30 秒调用；不要只信 push 消息体。",
    business_scene: "订单变更后补拉最终状态",
    required_params: ["tid"],
    response_keys: ["trade", "status"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "trade.memo.update",
    method: "youzan.trade.memo.update",
    version: "3.0.0",
    scope: "branch",
    token_scope: "branch",
    feature: "trade",
    capability_name: "订单备注更新",
    doc_url: "https://doc.youzanyun.com/detail/API/0/73",
    in_use: false,
    required: false,
    probe: null,
    description: "ERP 处理状态回写有赞备注。",
    business_scene: "ERP 标记已处理",
    required_params: ["tid", "memo"],
    response_keys: ["is_success"],
    retryable: false,
    fire_and_forget: true,
  },

  // =====================================================
  // 售后 / 退款
  // =====================================================
  {
    key: "trade.refund.search",
    method: "youzan.trade.refund.search",
    version: "3.0.1",
    scope: "branch",
    token_scope: "branch",
    feature: "refund",
    capability_name: "售后列表",
    doc_url: "https://doc.youzanyun.com/detail/API/0/69",
    in_use: false,
    required: false,
    probe: { params: { page_no: 1, page_size: 1, ...recentWindow() } },
    description: "售后单定时同步；进独立队列处理，不与普通订单混用。",
    business_scene: "售后列表定时补拉",
    required_params: ["page_no", "page_size"],
    response_keys: ["refunds", "refund_id"],
    retryable: true,
    fire_and_forget: false,
  },
  {
    key: "trade.refund.get",
    method: "youzan.trade.refund.get",
    version: "3.0.1",
    scope: "branch",
    token_scope: "branch",
    feature: "refund",
    capability_name: "售后详情",
    doc_url: "https://doc.youzanyun.com/detail/API/0/68",
    in_use: false,
    required: false,
    probe: null,
    description: "单笔售后详情。",
    business_scene: "单笔售后",
    required_params: ["refund_id"],
    response_keys: ["refund", "status", "refund_fee"],
    retryable: true,
    fire_and_forget: false,
  },

  // =====================================================
  // 物流 / 发货
  // =====================================================
  {
    key: "logistics.online.confirm",
    method: "youzan.logistics.online.confirm",
    version: "3.0.0",
    scope: "branch",
    token_scope: "branch",
    feature: "logistics",
    capability_name: "订单发货确认",
    doc_url: "https://doc.youzanyun.com/detail/API/0/49",
    in_use: false,
    required: false,
    probe: null,
    description: "ERP 触发有赞订单发货。",
    business_scene: "ERP 主导发货",
    required_params: ["tid", "out_stype", "logistics_no"],
    response_keys: ["is_success"],
    retryable: false,
    fire_and_forget: false,
  },
];

/** 便捷查询：按 method+version 拿一条 spec */
export function findSpec(method: string, version?: string): YzApiSpec | undefined {
  return YOUZAN_API_REGISTRY.find(
    (s) => s.method === method && (!version || s.version === version),
  );
}

/** 从错误信息中提取 gw_code；识别不出返回 null */
export function extractGwCode(msg: string): number | null {
  const m = msg.match(/gw\s*(\d{3,5})|\[(\d{3,5})\]/i);
  if (!m) return null;
  const raw = m[1] ?? m[2];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export type YzProbeStatus =
  | "ok"
  | "skip_write"
  | "skip_scope"
  | "token_fail"
  | "gw_4001"
  | "gw_4005"
  | "gw_4007"
  | "gw_other"
  | "network_error";

export function classifyError(err: string): YzProbeStatus {
  const gw = extractGwCode(err);
  if (gw === 4001 || gw === 4003) return "gw_4001";
  if (gw === 4005) return "gw_4005";
  if (gw === 4007) return "gw_4007";
  if (/白名单|whitelist|not in whitelist/i.test(err)) return "gw_4007";
  if (/未开通|无权限|no permission|not authorized/i.test(err)) return "gw_4005";
  if (gw) return "gw_other";
  if (/token|换 token|授权/i.test(err)) return "token_fail";
  return "network_error";
}

export const YZ_STATUS_LABELS: Record<YzProbeStatus, { label: string; hint: string }> = {
  ok: { label: "通过", hint: "调用成功" },
  skip_write: { label: "写入类跳过", hint: "写入类接口不做实调，参考『最近推送成功时间』" },
  skip_scope: { label: "不适用", hint: "该门店角色不使用此接口" },
  token_fail: { label: "Token 失败", hint: "换取 access_token 失败，请检查有赞授权" },
  gw_4001: { label: "授权失败", hint: "gw 4001/4003：access_token 无效或已过期" },
  gw_4005: { label: "能力未开通", hint: "gw 4005：请到有赞云后台『应用能力』勾选对应能力" },
  gw_4007: { label: "IP 未白名单", hint: "gw 4007：请配置固定出口代理，仅把代理 IP 加白" },
  gw_other: { label: "有赞异常", hint: "有赞侧返回其它错误码，见详情" },
  network_error: { label: "网络异常", hint: "HTTP/代理层错误" },
};
