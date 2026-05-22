// 集中管理的模拟数据，便于后续替换为真实 API

const sparkA = [12, 18, 14, 22, 19, 26, 31, 28, 34, 30, 38, 42];
const sparkB = [40, 38, 42, 46, 44, 50, 48, 54, 58, 56, 62, 68];
const sparkC = [22, 20, 24, 21, 25, 27, 23, 26, 28, 24, 22, 20];
const sparkD = [80, 86, 82, 90, 88, 96, 92, 100, 105, 102, 110, 118];

export const kpis = {
  todayRevenue: { value: 28640, delta: 8.4, spark: sparkA },
  monthRevenue: { value: 386520, delta: 12.6, spark: sparkB },
  inventoryValue: { value: 1240800, delta: -2.1, spark: sparkC },
  totalOrders: { value: 1842, delta: 5.3, spark: sparkD },
  newSku: { value: 124, delta: 18.2, spark: sparkA },
  pendingShip: { value: 36, delta: -4.0, spark: sparkC },
  lowStockAlerts: { value: 12, delta: 9.1, spark: sparkA },
  pendingCommission: { value: 48230, delta: 6.8, spark: sparkB },
  todayGoal: 40000,
};

export const channelShare = [
  { name: "日本大宗", value: 42, amount: 162400, delta: 6.2, fill: "var(--color-chart-1)" },
  { name: "日本小包", value: 18, amount: 69600, delta: 2.4, fill: "var(--color-chart-2)" },
  { name: "闲鱼", value: 16, amount: 61800, delta: -1.8, fill: "var(--color-chart-3)" },
  { name: "抖音", value: 12, amount: 46400, delta: 14.0, fill: "var(--color-chart-4)" },
  { name: "小红书/拼多多", value: 12, amount: 46400, delta: 3.6, fill: "var(--color-chart-5)" },
];

export const logisticsTrend = [
  { month: "5月", freight: 18200, tax: 4200, rate: 0.047 },
  { month: "6月", freight: 21500, tax: 5100, rate: 0.048 },
  { month: "7月", freight: 19800, tax: 4800, rate: 0.046 },
  { month: "8月", freight: 24300, tax: 5600, rate: 0.049 },
  { month: "9月", freight: 22100, tax: 5200, rate: 0.048 },
  { month: "10月", freight: 26800, tax: 6100, rate: 0.050 },
];

export const storeRanking = [
  { name: "上海·安福路店", value: 86420, type: "直营" as const },
  { name: "成都·太古里店", value: 72150, type: "加盟" as const },
  { name: "北京·三里屯店", value: 68900, type: "直营" as const },
  { name: "杭州·天目里店", value: 54300, type: "加盟" as const },
  { name: "广州·东山口店", value: 48200, type: "加盟" as const },
  { name: "深圳·万象天地店", value: 42100, type: "直营" as const },
  { name: "武汉·光谷店", value: 38600, type: "加盟" as const },
  { name: "长沙·IFS 店", value: 32100, type: "加盟" as const },
  { name: "南京·新街口店", value: 28400, type: "直营" as const },
  { name: "苏州·诚品店", value: 24800, type: "加盟" as const },
];

export type Batch = {
  id: string;
  name: string;
  cover: string;
  totalCost: number;
  expectedRevenue: number;
  currentRevenue: number;
  itemCount: number;
  expectedBreakeven: string;
};

export const batches: Batch[] = [
  {
    id: "B-2025-018",
    name: "10月日本九州杂货批",
    cover: "https://images.unsplash.com/photo-1528698827591-e19ccd7bc23d?w=200&q=80",
    totalCost: 86200,
    expectedRevenue: 240000,
    currentRevenue: 168400,
    itemCount: 312,
    expectedBreakeven: "2026-06-15",
  },
  {
    id: "B-2025-017",
    name: "10月大阪古着精选",
    cover: "https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=200&q=80",
    totalCost: 124000,
    expectedRevenue: 320000,
    currentRevenue: 348000,
    itemCount: 186,
    expectedBreakeven: "2026-04-22",
  },
  {
    id: "B-2025-016",
    name: "9月东京拍卖集货",
    cover: "https://images.unsplash.com/photo-1513519245088-0e12902e5a38?w=200&q=80",
    totalCost: 68400,
    expectedRevenue: 180000,
    currentRevenue: 92400,
    itemCount: 264,
    expectedBreakeven: "2026-07-08",
  },
  {
    id: "B-2025-015",
    name: "9月名古屋家居杂货",
    cover: "https://images.unsplash.com/photo-1512446816042-444d641267d4?w=200&q=80",
    totalCost: 42000,
    expectedRevenue: 120000,
    currentRevenue: 38600,
    itemCount: 198,
    expectedBreakeven: "2026-08-30",
  },
];

export const japanBulk = [
  { id: "JP-B-1024", trackingNo: "EH123456789JP", orderCount: 24, weight: 86.4, jpyAmount: 1820000, rate: 0.048, freight: 6800, tax: 1240, status: "已入库", eta: "2026-05-08" },
  { id: "JP-B-1023", trackingNo: "EH987654321JP", orderCount: 18, weight: 62.2, jpyAmount: 1240000, rate: 0.049, freight: 5400, tax: 980, status: "运输中", eta: "2026-05-14" },
  { id: "JP-B-1022", trackingNo: "EH555888777JP", orderCount: 31, weight: 124.8, jpyAmount: 2640000, rate: 0.048, freight: 9200, tax: 1820, status: "清关中", eta: "2026-05-12" },
  { id: "JP-B-1021", trackingNo: "EH111222333JP", orderCount: 12, weight: 38.6, jpyAmount: 680000, rate: 0.047, freight: 3200, tax: 540, status: "已入库", eta: "2026-05-04" },
];

export const japanParcel = [
  { id: "JP-S-2048", emsNo: "EM123JP", item: "Showa 复古玻璃杯 ×4", seller: "yahoo_kobe_88", jpy: 8400, status: "派送中", image: "https://images.unsplash.com/photo-1567696911980-2eed69a46042?w=300&q=80", eta: "2026-05-15" },
  { id: "JP-S-2047", emsNo: "EM456JP", item: "中古 SONY 收音机", seller: "mercari_tokyo_22", jpy: 12800, status: "已入库", image: "https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=300&q=80", eta: "2026-05-06" },
  { id: "JP-S-2046", emsNo: "EM789JP", item: "古布制束口袋 ×6", seller: "rakuten_oka_05", jpy: 5200, status: "清关中", image: "https://images.unsplash.com/photo-1605000797499-95a51c5269ae?w=300&q=80", eta: "2026-05-13" },
  { id: "JP-S-2045", emsNo: "EM321JP", item: "昭和漆器礼盒", seller: "yahoo_osaka_71", jpy: 18600, status: "运输中", image: "https://images.unsplash.com/photo-1603071091205-04afa05a1c8a?w=300&q=80", eta: "2026-05-16" },
];

export const domesticOrders = {
  闲鱼: [
    { id: "XY-3201", title: "80年代搪瓷杯怀旧", seller: "怀旧老物收藏馆", price: 38, status: "已发货", date: "2026-05-09" },
    { id: "XY-3200", title: "老式胶片相机一台", seller: "胶片时代", price: 280, status: "待发货", date: "2026-05-10" },
    { id: "XY-3199", title: "上海牌老式手表", seller: "老货回收站", price: 420, status: "已收货", date: "2026-05-07" },
  ],
  抖音: [
    { id: "DY-5512", title: "复古铁皮玩具盲盒", seller: "童年记忆 vintage", price: 128, status: "已收货", date: "2026-05-08" },
    { id: "DY-5511", title: "中古真皮单肩包", seller: "古着 select shop", price: 320, status: "已发货", date: "2026-05-09" },
    { id: "DY-5510", title: "70年代搪瓷盆", seller: "上海老物件", price: 86, status: "已发货", date: "2026-05-09" },
  ],
  小红书: [
    { id: "XHS-2201", title: "vintage 玻璃花瓶", seller: "复古杂货铺", price: 88, status: "已收货", date: "2026-05-06" },
    { id: "XHS-2200", title: "日本中古陶瓷盘 ×4", seller: "东瀛旧物", price: 268, status: "已发货", date: "2026-05-08" },
  ],
  拼多多: [
    { id: "PDD-9901", title: "怀旧国货搪瓷盘 ×3", seller: "国货经典", price: 45, status: "已发货", date: "2026-05-09" },
  ],
};

export const logisticsTracking = [
  {
    id: "JP-B-1023",
    title: "JP-B-1023 · 10月大阪集货",
    carrier: "EMS · EH987654321JP",
    progress: 60,
    steps: [
      { label: "下单", date: "2026-04-28", done: true },
      { label: "日本仓打包", date: "2026-05-01", done: true },
      { label: "国际运输", date: "2026-05-04", done: true },
      { label: "国内清关", date: "2026-05-09", done: false, current: true },
      { label: "国内派送", date: "—", done: false },
      { label: "入库总仓", date: "—", done: false },
    ],
  },
  {
    id: "JP-B-1022",
    title: "JP-B-1022 · 9月东京拍卖",
    carrier: "EMS · EH555888777JP",
    progress: 80,
    steps: [
      { label: "下单", date: "2026-04-20", done: true },
      { label: "日本仓打包", date: "2026-04-23", done: true },
      { label: "国际运输", date: "2026-04-27", done: true },
      { label: "国内清关", date: "2026-05-02", done: true },
      { label: "国内派送", date: "2026-05-08", done: false, current: true },
      { label: "入库总仓", date: "—", done: false },
    ],
  },
];

export type Product = {
  id: string;
  sku: string;
  rfidEpc: string | null;
  name: string;
  image: string;
  brand: string;
  category: string;
  batchId: string;
  estimatedCost: number;
  retailPrice: number;
  status: "在库" | "已调拨" | "已售出";
  store?: string;
};

export const products: Product[] = [
  { id: "P-10248", sku: "BO-VG-0248", rfidEpc: null, name: "昭和复古玻璃糖果罐", image: "https://images.unsplash.com/photo-1567696911980-2eed69a46042?w=400&q=80", brand: "昭和硝子", category: "玻璃器", batchId: "B-2025-018", estimatedCost: 42, retailPrice: 168, status: "在库", store: "总仓·上海" },
  { id: "P-10247", sku: "BO-CR-0247", rfidEpc: "E280-1100-0000-0247", name: "中古陶瓷茶壶", image: "https://images.unsplash.com/photo-1556909114-44e3e8c1edc4?w=400&q=80", brand: "九谷烧", category: "陶瓷", batchId: "B-2025-018", estimatedCost: 68, retailPrice: 248, status: "已调拨", store: "上海·安福路店" },
  { id: "P-10246", sku: "BO-TX-0246", rfidEpc: null, name: "古布束口袋（蓝染）", image: "https://images.unsplash.com/photo-1605000797499-95a51c5269ae?w=400&q=80", brand: "民艺", category: "布艺", batchId: "B-2025-017", estimatedCost: 28, retailPrice: 98, status: "已售出" },
  { id: "P-10245", sku: "BO-MT-0245", rfidEpc: null, name: "铁皮发条玩具·大象", image: "https://images.unsplash.com/photo-1558877385-81a1c7e67d72?w=400&q=80", brand: "Yonezawa", category: "玩具", batchId: "B-2025-017", estimatedCost: 86, retailPrice: 320, status: "在库", store: "总仓·上海" },
  { id: "P-10244", sku: "BO-EL-0244", rfidEpc: "E280-1100-0000-0244", name: "SONY 中古收音机", image: "https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=400&q=80", brand: "SONY", category: "电子", batchId: "B-2025-016", estimatedCost: 240, retailPrice: 880, status: "在库", store: "成都·太古里店" },
  { id: "P-10243", sku: "BO-VG-0243", rfidEpc: null, name: "切子玻璃清酒杯 ×2", image: "https://images.unsplash.com/photo-1551525212-a1dc18871d4a?w=400&q=80", brand: "江户切子", category: "玻璃器", batchId: "B-2025-016", estimatedCost: 56, retailPrice: 198, status: "已售出" },
  { id: "P-10242", sku: "BO-FN-0242", rfidEpc: null, name: "昭和木制小凳", image: "https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?w=400&q=80", brand: "无名匠人", category: "家具", batchId: "B-2025-015", estimatedCost: 120, retailPrice: 420, status: "在库", store: "总仓·上海" },
  { id: "P-10241", sku: "BO-CR-0241", rfidEpc: null, name: "有田烧手绘小盘 ×4", image: "https://images.unsplash.com/photo-1530062845289-9109b2c9c868?w=400&q=80", brand: "有田烧", category: "陶瓷", batchId: "B-2025-015", estimatedCost: 88, retailPrice: 298, status: "在库", store: "北京·三里屯店" },
];

export const transfers = [
  { id: "TR-0421", from: "总仓·上海", to: "上海·安福路店", items: 24, value: 8420, status: "已签收", date: "2026-05-08", operator: "张明" },
  { id: "TR-0420", from: "总仓·上海", to: "成都·太古里店", items: 36, value: 12860, status: "运输中", date: "2026-05-09", operator: "李华" },
  { id: "TR-0419", from: "总仓·上海", to: "北京·三里屯店", items: 18, value: 6240, status: "待发货", date: "2026-05-10", operator: "王芳" },
  { id: "TR-0418", from: "上海·安福路店", to: "杭州·天目里店", items: 12, value: 4180, status: "已签收", date: "2026-05-06", operator: "陈强" },
];

export const stores = [
  { id: "S-001", type: "直营" as const, name: "上海·安福路店", franchisee: "—", manager: "周晓", youzanId: "yz_88001", address: "上海市徐汇区安福路 322 号", area: 86, monthRevenue: 86420, turnover: 1.8, status: "营业中", image: "https://images.unsplash.com/photo-1604719312566-8912e9227c6a?w=600&q=80" },
  { id: "S-002", type: "直营" as const, name: "北京·三里屯店", franchisee: "—", manager: "刘洋", youzanId: "yz_88002", address: "北京市朝阳区三里屯路 19 号", area: 92, monthRevenue: 68900, turnover: 1.5, status: "营业中", image: "https://images.unsplash.com/photo-1582037928769-181f2644ecb7?w=600&q=80" },
  { id: "S-003", type: "加盟" as const, name: "成都·太古里店", franchisee: "李雪", manager: "赵雅", youzanId: "yz_88003", address: "成都市锦江区中纱帽街", area: 78, monthRevenue: 72150, turnover: 1.7, status: "营业中", image: "https://images.unsplash.com/photo-1567521464027-f127ff144326?w=600&q=80" },
  { id: "S-004", type: "加盟" as const, name: "杭州·天目里店", franchisee: "王浩", manager: "—", youzanId: "yz_88004", address: "杭州市西湖区天目里", area: 64, monthRevenue: 0, turnover: 0, status: "装修中", image: "https://images.unsplash.com/photo-1604061986761-d9d0cc41b0d1?w=600&q=80" },
  { id: "S-005", type: "加盟" as const, name: "广州·东山口店", franchisee: "陈敏", manager: "黄丽", youzanId: "yz_88005", address: "广州市越秀区东山口", area: 72, monthRevenue: 48200, turnover: 1.4, status: "营业中", image: "https://images.unsplash.com/photo-1559762717-99c81ac85459?w=600&q=80" },
];

export const franchisees = [
  { id: "F-01", name: "李雪", avatar: "李", contractStart: "2024-08-31", contractEnd: "2027-08-31", stores: 1, totalCommission: 184600, materialProgress: 100, decorationProgress: 100 },
  { id: "F-02", name: "王浩", avatar: "王", contractStart: "2025-03-15", contractEnd: "2028-03-15", stores: 1, totalCommission: 0, materialProgress: 80, decorationProgress: 65 },
  { id: "F-03", name: "陈敏", avatar: "陈", contractStart: "2024-11-20", contractEnd: "2027-11-20", stores: 1, totalCommission: 96400, materialProgress: 100, decorationProgress: 100 },
  { id: "F-04", name: "赵琳", avatar: "赵", contractStart: "2025-06-30", contractEnd: "2028-06-30", stores: 0, totalCommission: 0, materialProgress: 30, decorationProgress: 10 },
];

export const knowledgeArticles = [
  { id: "K-001", type: "商品知识", title: "昭和玻璃器鉴别要点", excerpt: "如何通过厚薄、色泽、气泡判断昭和早期手工玻璃器…", views: 1284, updated: "2026-04-22", cover: "https://images.unsplash.com/photo-1567696911980-2eed69a46042?w=400&q=80" },
  { id: "K-002", type: "SOP", title: "门店日常开店流程 SOP v2.1", excerpt: "包含 8 个标准动作：开灯、开机、清洁、补货、晨会…", views: 2148, updated: "2026-05-01", cover: "https://images.unsplash.com/photo-1567521464027-f127ff144326?w=400&q=80" },
  { id: "K-003", type: "QA", title: "顾客常见问题应答手册", excerpt: "覆盖 32 个高频问题：是否包邮、是否真品、保养建议…", views: 986, updated: "2026-04-18", cover: "https://images.unsplash.com/photo-1556909114-44e3e8c1edc4?w=400&q=80" },
  { id: "K-004", type: "装修流程", title: "新店装修标准流程与节点", excerpt: "从签约到开业 90 天交付的全流程检查清单…", views: 642, updated: "2026-03-30", cover: "https://images.unsplash.com/photo-1604719312566-8912e9227c6a?w=400&q=80" },
  { id: "K-005", type: "商品知识", title: "中古布艺品保养指南", excerpt: "蓝染、绞缬、刺子绣的清洁与防虫存放方法…", views: 528, updated: "2026-04-10", cover: "https://images.unsplash.com/photo-1605000797499-95a51c5269ae?w=400&q=80" },
  { id: "K-006", type: "SOP", title: "RFID 盘点标准操作流程", excerpt: "使用手持终端在 30 分钟内完成全店盘点的步骤…", views: 1042, updated: "2026-04-26", cover: "https://images.unsplash.com/photo-1556761175-5973dc0f32e7?w=400&q=80" },
];

export const knowledgeCategories = [
  { id: "all", label: "全部文章", count: 64 },
  { id: "product", label: "商品知识", count: 18 },
  { id: "sop", label: "标准 SOP", count: 22 },
  { id: "qa", label: "问答手册", count: 9 },
  { id: "deco", label: "装修流程", count: 7 },
  { id: "brand", label: "品牌手册", count: 8 },
];

import {
  Package,
  Truck,
  ArrowLeftRight,
  Tag,
  AlertTriangle,
  ShoppingBag,
  Store,
  Users,
} from "lucide-react";

export const recentActivities = [
  { id: "A1", icon: Package, title: "JP-B-1024 大宗包裹已入库", description: "24 单 · 总价值 ¥87,360", time: "12 分钟前", tone: "success" as const },
  { id: "A2", icon: Truck, title: "TR-0420 调拨发出", description: "上海总仓 → 成都·太古里店 · 36 件", time: "1 小时前", tone: "info" as const },
  { id: "A3", icon: Tag, title: "新增 SKU · BO-VG-0248", description: "昭和复古玻璃糖果罐 · ¥168", time: "2 小时前", tone: "primary" as const },
  { id: "A4", icon: ShoppingBag, title: "抖音订单 DY-5512 已完成", description: "复古铁皮玩具盲盒 · ¥128", time: "3 小时前", tone: "muted" as const },
  { id: "A5", icon: AlertTriangle, title: "广州·东山口店库存预警", description: "陶瓷品类剩余 4 件，低于安全阈值", time: "4 小时前", tone: "warning" as const },
  { id: "A6", icon: Users, title: "新加盟商申请 · 苏州·赵琳", description: "等待材料审核", time: "5 小时前", tone: "primary" as const },
  { id: "A7", icon: Store, title: "杭州·天目里店装修进度更新", description: "材料 80% · 装修 65%", time: "今天 09:24", tone: "info" as const },
  { id: "A8", icon: ArrowLeftRight, title: "TR-0418 已签收", description: "上海·安福路 → 杭州·天目里 · 12 件", time: "昨天", tone: "success" as const },
];

export const todoItems = [
  { id: "T1", label: "加盟申请待审核", count: 3, tone: "primary" as const, href: "/shop-mgmt/franchisees" },
  { id: "T2", label: "包裹待清关", count: 2, tone: "warning" as const, href: "/purchase/logistics" },
  { id: "T3", label: "门店库存预警", count: 5, tone: "destructive" as const, href: "/inventory/products" },
  { id: "T4", label: "调拨待发货", count: 4, tone: "info" as const, href: "/inventory/transfers" },
  { id: "T5", label: "加盟商待结算", count: 2, tone: "success" as const, href: "/shop-mgmt/franchisees" },
];

export const youzanSyncLog = [
  { id: "Y1", time: "2026-05-12 14:32", action: "全量订单同步", status: "成功", count: 184 },
  { id: "Y2", time: "2026-05-12 13:32", action: "商品库存同步", status: "成功", count: 1248 },
  { id: "Y3", time: "2026-05-12 12:32", action: "全量订单同步", status: "成功", count: 162 },
  { id: "Y4", time: "2026-05-12 11:32", action: "会员资料同步", status: "失败", count: 0 },
  { id: "Y5", time: "2026-05-12 10:32", action: "全量订单同步", status: "成功", count: 142 },
];
