// 中古杂货库存模块常量与工具函数（client-safe）

/**
 * 14 个业务一级类目。一级类目同时是标准商品名称。
 * 「待归类 / AI低置信度 / 新品类候选 / 合规待审」是后台系统兜底类目，
 * 不生成标准商品、不在 POS 展示，因此不在这里列出。
 */
export const INV_CATEGORIES = [
  { value: "porcelain_jp", label: "日本瓷器", code: "JP" },
  { value: "porcelain_eu", label: "欧洲瓷器", code: "EU" },
  { value: "porcelain_cartoon", label: "卡通瓷器", code: "CP" },
  { value: "toy_model", label: "玩具模型", code: "TY" },
  { value: "character_ip_goods", label: "角色周边", code: "AN" },
  { value: "audio_media", label: "唱片影音", code: "MD" },
  { value: "digital_appliance", label: "数码家电", code: "DG" },
  { value: "game_device", label: "游戏设备", code: "GM" },
  { value: "home_goods", label: "家居杂货", code: "HM" },
  { value: "stationery_publication", label: "文具书刊", code: "SP" },
  { value: "fashion_wearable", label: "服饰穿戴", code: "FS" },
  { value: "fashion_jewelry", label: "珠宝首饰", code: "JW" },
  { value: "art_collectible", label: "古美术", code: "AT" },
  { value: "daily_misc", label: "日用杂货", code: "DL" },
] as const;

export type InvCategory = (typeof INV_CATEGORIES)[number]["value"];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  INV_CATEGORIES.map((c) => [c.value, c.label]),
);

export const CATEGORY_CODE: Record<string, string> = Object.fromEntries(
  INV_CATEGORIES.map((c) => [c.value, c.code]),
);

export const PRICE_TIERS = [
  6.9, 9.9, 15.9, 19.9, 29.9, 39.9, 49.9, 59.9, 69, 79, 89, 99, 129, 159, 199, 259, 299, 359, 399,
  459, 499, 580, 680, 780, 880, 980, 1080, 1180, 1280, 1380, 1580,
] as const;


export type SkuKind = "single" | "pack" | "bundle";

export const SKU_KIND_LABEL: Record<SkuKind, string> = {
  single: "单品",
  pack: "组包",
  bundle: "组包",
};

export const SKU_STATUS_LABEL: Record<string, string> = {
  active: "在售",
  archived: "已归档",
};

const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 生成 EPC：INV-{类目码}-{价格*10 共5位，最高 ¥9999.9}-{6位随机 base36} */
export function generateEpc(category: string, priceTier: number): string {
  const code = CATEGORY_CODE[category] ?? "XX";
  const tier = Math.min(99999, Math.max(0, Math.round(priceTier * 10)))
    .toString()
    .padStart(5, "0");
  let rand = "";
  for (let i = 0; i < 6; i++) {
    rand += BASE36[Math.floor(Math.random() * BASE36.length)];
  }
  return `INV-${code}-${tier}-${rand}`;
}

/** 生成商品编码：SKU/PKG-{类目码}-{YYMMDD}-{4位随机 base36} */
export function generateSkuCode(category: string, kind: SkuKind = "single"): string {
  const code = CATEGORY_CODE[category] ?? "XX";
  const prefix = kind === "bundle" ? "PKG" : "SKU";
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  let rand = "";
  for (let i = 0; i < 4; i++) rand += BASE36[Math.floor(Math.random() * BASE36.length)];
  return `${prefix}-${code}-${yy}${mm}${dd}-${rand}`;
}


export function formatPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  return `¥${Number(v).toFixed(2)}`;
}

/** 把扫描得到的 EPC 列表聚合成 (epc → 件数) */
export function aggregateScans(epcs: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of epcs) {
    const k = e.trim();
    if (!k) continue;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

// ---------- 标准商品聚合 ----------

export type SkuRow = {
  id: string;
  category: string;
  name: string;
  sku_code: string | null;
  price_tier: number;
  is_custom_price: boolean;
  kind: string;
  pack_pieces: number | null;
  bundle_items: unknown;
  weight_g: number | null;
  image_url: string | null;
  image_paths?: string[] | null;
  notes: string | null;
  status: string;
  epc: string;
  stock_qty: number;
  created_at: string;
};

export type StandardProductGroup = {
  key: string;
  code: string | null;
  category: string;
  name: string;
  image_url: string | null;
  weight_g: number | null;
  notes: string | null;
  skus: SkuRow[];
  totalStock: number;
  tiers: number[];
  createdAt: string;
};

/** 按 sku_code（无则 category|name）聚合标准 SKU */
export function groupStandardSkus(rows: SkuRow[]): StandardProductGroup[] {
  const groups = new Map<string, StandardProductGroup>();
  for (const r of rows) {
    const key = (r.sku_code && r.sku_code.trim()) || `${r.category}|${r.name}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        code: r.sku_code ?? null,
        category: r.category,
        name: r.name,
        image_url: r.image_url,
        weight_g: r.weight_g,
        notes: r.notes,
        skus: [],
        totalStock: 0,
        tiers: [],
        createdAt: r.created_at,
      };
      groups.set(key, g);
    }
    g.skus.push(r);
    g.totalStock += r.stock_qty ?? 0;
    if (!g.image_url && r.image_url) g.image_url = r.image_url;
    if (r.created_at > g.createdAt) g.createdAt = r.created_at;
  }
  for (const g of groups.values()) {
    g.skus.sort((a, b) => Number(a.price_tier) - Number(b.price_tier));
    g.tiers = g.skus.map((s) => Number(s.price_tier));
  }
  return Array.from(groups.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
