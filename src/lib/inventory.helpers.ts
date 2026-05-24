// 中古杂货库存模块常量与工具函数（client-safe）

export const INV_CATEGORIES = [
  { value: "jp_porcelain", label: "日本瓷器", code: "JP" },
  { value: "eu_porcelain", label: "欧洲瓷器", code: "EU" },
  { value: "vintage_toy", label: "中古玩具", code: "TY" },
  { value: "anime_goods", label: "二次元周边", code: "AN" },
  { value: "media", label: "音像制品", code: "MD" },
  { value: "digital", label: "数码家电", code: "DG" },
  { value: "jewelry", label: "珠宝首饰", code: "JW" },
  { value: "fashion", label: "时尚配件", code: "FS" },
  { value: "daily", label: "日用杂货", code: "DL" },
  { value: "antique", label: "古美术", code: "AT" },
] as const;

export type InvCategory = (typeof INV_CATEGORIES)[number]["value"];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  INV_CATEGORIES.map((c) => [c.value, c.label]),
);

export const CATEGORY_CODE: Record<string, string> = Object.fromEntries(
  INV_CATEGORIES.map((c) => [c.value, c.code]),
);

export const PRICE_TIERS = [6.9, 9.9, 15.9, 19.9, 29.9, 39.9, 49.9] as const;

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
