// ============================================================
// 有赞 API 全量登记表
// ------------------------------------------------------------
// 用途：
//  1. /youzan「API 能力体检」按此清单对每家门店逐个探测；
//  2. 出现 [gw 4005] 时直接告诉运营去有赞后台开哪个中文能力名；
//  3. 后续新增有赞接口时，先在这里登记再写调用代码。
//
// 只列 ERP 已经使用 (in_use=true) 或者近期规划要接入 (in_use=false)
// 的接口；纯写入类接口 probe=null 表示体检不做真实调用（避免误改数据）。
// ============================================================

export type YzApiScope = "hq" | "branch" | "both";

export type YzApiFeature =
  | "auth"
  | "shop_info"
  | "category"
  | "product_master"
  | "product_online"
  | "stock"
  | "trade"
  | "logistics"
  | "member"
  | "coupon";

export const YZ_FEATURE_LABELS: Record<YzApiFeature, string> = {
  auth: "授权 / Token",
  shop_info: "门店 · 员工 · 库位",
  category: "类目 / 分组",
  product_master: "商品主数据 (SPU)",
  product_online: "门店在售商品",
  stock: "库存 (写入)",
  trade: "交易 / 订单",
  logistics: "物流 / 售后",
  member: "会员 / 客户",
  coupon: "优惠券 / 营销",
};

export type YzApiSpec = {
  key: string;
  method: string;
  version: string;
  scope: YzApiScope;
  feature: YzApiFeature;
  capability_name: string;
  doc_url: string;
  in_use: boolean;
  required: boolean;
  /** 只读探测参数；null = 写入类接口，体检时跳过实调，只显示"最近推送成功时间" */
  probe: { params: Record<string, string | number | boolean> } | null;
  /** 用于 UI 展示的中文说明 */
  description: string;
};

/** 生成 trades.sold.get 需要的最近 7 天窗口 */
function recentWindow() {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
  return { start_created: fmt(start), end_created: fmt(end) };
}

export const YOUZAN_API_REGISTRY: YzApiSpec[] = [
  // ------ 授权 ------
  {
    key: "auth.token",
    method: "auth/token",
    version: "silent",
    scope: "both",
    feature: "auth",
    capability_name: "自用型应用授权 (client_credentials / silent)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/906",
    in_use: true,
    required: true,
    probe: { params: {} }, // 特殊：由 health 模块直接调用 ensureAccessToken
    description: "获取每家门店 access_token；所有接口的前置条件。",
  },

  // ------ 门店 / 员工 / 库位 ------
  {
    key: "shop.get",
    method: "youzan.shop.get",
    version: "3.0.0",
    scope: "both",
    feature: "shop_info",
    capability_name: "查询店铺基本信息",
    doc_url: "https://doc.youzanyun.com/detail/API/0/17",
    in_use: true,
    required: true,
    probe: { params: {} },
    description: "读取当前 kdt_id 的店铺名/类型，作为 ping 用。",
  },
  {
    key: "retail.shop.list.query",
    method: "youzan.retail.shop.list.query",
    version: "1.0.0",
    scope: "hq",
    feature: "shop_info",
    capability_name: "连锁 · 查询门店列表",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1793",
    in_use: true,
    required: true,
    probe: { params: { page_no: 1, page_size: 1 } },
    description: "总部枚举所有分店 kdt_id，用于批量导入。",
  },
  {
    key: "retail.shop.query",
    method: "youzan.retail.shop.query",
    version: "1.0.0",
    scope: "hq",
    feature: "shop_info",
    capability_name: "连锁 · 查询单店详情",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1792",
    in_use: false,
    required: false,
    probe: { params: { page_no: 1, page_size: 1 } },
    description: "备用：按门店 ID 查详情。",
  },

  // ------ 类目 / 分组 ------
  {
    key: "itemcategories.tags.get",
    method: "youzan.itemcategories.tags.get",
    version: "3.0.0",
    scope: "both",
    feature: "category",
    capability_name: "查询店铺分组 (标签 tag)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/108",
    in_use: true,
    required: true,
    probe: { params: {} },
    description: "拉取一/二级分组，用于 ERP 分类 ↔ 有赞分组绑定。",
  },
  {
    key: "itemcategories.shop.get",
    method: "youzan.itemcategories.shop.get",
    version: "3.0.0",
    scope: "both",
    feature: "category",
    capability_name: "查询店铺自定义分类 (兜底)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/107",
    in_use: false,
    required: false,
    probe: { params: {} },
    description: "旧版分类接口；tags.get 不可用时兜底。",
  },

  // ------ 商品 SPU ------
  {
    key: "retail.open.spu.query",
    method: "youzan.retail.open.spu.query",
    version: "3.0.0",
    scope: "hq",
    feature: "product_master",
    capability_name: "连锁 · 查询总部 SPU 商品库",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1789",
    in_use: true,
    required: true,
    probe: { params: { page_no: 1, page_size: 1 } },
    description: "总部商品库 SPU 主数据（HQ 侧）。",
  },
  {
    key: "retail.open.online.spu.query",
    method: "youzan.retail.open.online.spu.query",
    version: "1.0.0",
    scope: "branch",
    feature: "product_online",
    capability_name: "连锁 · 查询门店在售 SPU",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1790",
    in_use: true,
    required: true,
    probe: { params: { page_no: 1, page_size: 1 } },
    description: "分店已上架的 SPU，用于对账。",
  },
  {
    key: "retail.open.spu.add",
    method: "youzan.retail.open.spu.add",
    version: "1.0.0",
    scope: "hq",
    feature: "product_master",
    capability_name: "连锁 · 新增总部 SPU",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1788",
    in_use: true,
    required: true,
    probe: null,
    description: "写入类：ERP 新建 SKU 时自动登记 HQ SPU；体检不实调。",
  },

  // ------ 库存（写入类） ------
  {
    key: "retail.open.stock.update",
    method: "youzan.retail.open.stock.update",
    version: "1.0.0",
    scope: "hq",
    feature: "stock",
    capability_name: "连锁 · 总部按 kdt_id 更新库存",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1791",
    in_use: true,
    required: true,
    probe: null,
    description: "写入类：ERP 分店库存推送；体检不实调，改看历史推送时间。",
  },
  {
    key: "item.quantity.update",
    method: "youzan.item.quantity.update",
    version: "3.0.0",
    scope: "branch",
    feature: "stock",
    capability_name: "商品库存增减 / 设置",
    doc_url: "https://doc.youzanyun.com/detail/API/0/45",
    in_use: true,
    required: true,
    probe: null,
    description: "写入类：分店直推库存 (type=1/2/3)；体检不实调。",
  },

  // ------ 交易 ------
  {
    key: "trades.sold.get",
    method: "youzan.trades.sold.get",
    version: "3.0.0",
    scope: "branch",
    feature: "trade",
    capability_name: "查询已卖出的交易 (订单列表)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/70",
    in_use: true,
    required: true,
    probe: { params: { page_no: 1, page_size: 1, ...recentWindow() } },
    description: "按 kdt_id 拉取分店订单，供仪表盘使用。",
  },

  // ------ 规划但暂未接入 ------
  {
    key: "logistics.online.confirm",
    method: "youzan.logistics.online.confirm",
    version: "4.0.0",
    scope: "branch",
    feature: "logistics",
    capability_name: "订单发货 (在线发货)",
    doc_url: "https://doc.youzanyun.com/detail/API/0/49",
    in_use: false,
    required: false,
    probe: null,
    description: "规划中：ERP 触发有赞订单发货。",
  },
  {
    key: "trades.refund.get",
    method: "youzan.trades.refund.get",
    version: "3.0.0",
    scope: "branch",
    feature: "logistics",
    capability_name: "查询退款单",
    doc_url: "https://doc.youzanyun.com/detail/API/0/69",
    in_use: false,
    required: false,
    probe: { params: { page_no: 1, page_size: 1, ...recentWindow() } },
    description: "规划中：售后统计。",
  },
  {
    key: "users.weixin.follower.get",
    method: "youzan.users.weixin.follower.get",
    version: "3.0.0",
    scope: "branch",
    feature: "member",
    capability_name: "查询会员信息",
    doc_url: "https://doc.youzanyun.com/detail/API/0/1155",
    in_use: false,
    required: false,
    probe: null,
    description: "规划中：会员数据同步。",
  },
  {
    key: "ump.coupon.list.query",
    method: "youzan.ump.coupon.list.query",
    version: "1.0.0",
    scope: "branch",
    feature: "coupon",
    capability_name: "查询优惠券列表",
    doc_url: "https://doc.youzanyun.com/detail/API/0/2246",
    in_use: false,
    required: false,
    probe: { params: { page_no: 1, page_size: 1 } },
    description: "规划中：优惠券营销数据。",
  },
];

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
  | "gw_4001" // 授权错误
  | "gw_4005" // 能力未开通
  | "gw_4007" // IP 未白名单
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
