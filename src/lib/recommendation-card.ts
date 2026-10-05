/**
 * 商品推荐卡（60×90mm 竖版）结构化内容：纯函数，无 IO。
 * - 只用 ERP 已确认事实：名称/类目/成色/品牌/IP/关键词；不带价格、成本、备注、采购信息。
 * - AI 文案若出现事实里没有的年份/品牌/稀缺性断言 → 丢弃，回退到 source=product。
 */
import { z } from "zod";

export type CardFacts = {
  sku_id: string;
  sku_scope: "standard" | "custom";
  name: string;
  category: string | null;
  condition_grade: string | null;
  brand: string | null;
  ip: string | null;
  keywords: string[];
};

export type RecommendationCard = {
  card_type: "product_recommendation";
  size_mm: { width: 60; height: 90 };
  source: "ai" | "product";
  /** AI 失败/被拒时的机器可读原因；source=ai 时为 null。 */
  fallback_reason: string | null;
  headline: string;
  product_name: string;
  keywords: string[];
  intro: string;
  highlights: string[];
  facts: Pick<CardFacts, "brand" | "ip" | "category" | "condition_grade">;
  image: { storage_path: string | null; read_url: string | null; status: "ready" | "missing" };
  /** 二维码按门店配置，此接口不生成；缺码时由客户端显示待处理。 */
  qr: { status: "not_configured" };
};

export const AiCardSchema = z
  .object({
    headline: z.string().trim().min(2).max(18),
    keywords: z.array(z.string().trim().min(1).max(6)).min(2).max(3),
    intro: z.string().trim().min(4).max(60),
    highlights: z
      .array(z.string().trim().min(2).max(24))
      .min(1)
      .max(3)
      // 60×90mm 卡面容量：highlights 以「；」连接后总长（含分隔符）≤55 字
      .refine((lines) => lines.join("；").length <= 55, { message: "highlights_total_too_long" }),
  })
  .strict();
export type AiCard = z.infer<typeof AiCardSchema>;

const BANNED =
  /(限量|限定|绝版|稀有|收藏级|保值|升值|正品|前主人|生产于|制造于|功能正常|测试正常|联名|官方|\d{2}\s*年代|(?:19|20)\d{2})/i;

/** AI 文案的事实闸门：返回拒绝原因，null 表示可用。 */
export function rejectAiCard(card: AiCard, facts: CardFacts): string | null {
  const texts = [card.headline, card.intro, ...card.keywords, ...card.highlights];
  if (texts.some((t) => BANNED.test(t))) return "ai_unsupported_claim";
  if (/https?:|<[a-z]/i.test(texts.join(" "))) return "ai_invalid_markup";
  // 未确认品牌/IP 时，文案里不得冒出品牌英文名（粗粒度：拉丁大写单词）
  if (!facts.brand && !facts.ip && texts.some((t) => /\b[A-Z][A-Za-z]{2,}\b/.test(t)))
    return "ai_unconfirmed_brand";
  return null;
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n) : s;
}

/** 纯事实模板（AI 不可用时的确定性回退）。 */
export function productCard(facts: CardFacts): Omit<RecommendationCard, "image" | "source" | "fallback_reason"> {
  const subject = facts.ip ?? facts.brand ?? facts.category ?? "店长推荐";
  const kw = [facts.ip, facts.brand, facts.category, ...facts.keywords]
    .filter((x): x is string => !!x && x.trim().length > 0)
    .map((x) => clip(x.trim(), 6));
  const keywords = [...new Set(kw)].slice(0, 3);
  const highlights = [
    facts.condition_grade ? `成色 ${facts.condition_grade}` : null,
    facts.sku_scope === "custom" ? "单件中古，售完即止" : null,
  ].filter((x): x is string => !!x);
  return {
    card_type: "product_recommendation",
    size_mm: { width: 60, height: 90 },
    headline: clip(`${subject}好物`, 18),
    product_name: clip(facts.name, 24),
    keywords,
    intro: clip(`${facts.name}，到店可看实物。`, 60),
    highlights: highlights.length ? highlights : ["欢迎到店看实物"],
    facts: {
      brand: facts.brand,
      ip: facts.ip,
      category: facts.category,
      condition_grade: facts.condition_grade,
    },
    qr: { status: "not_configured" },
  };
}

export function mergeAiCard(facts: CardFacts, ai: AiCard) {
  const base = productCard(facts);
  return { ...base, headline: ai.headline, keywords: ai.keywords, intro: ai.intro, highlights: ai.highlights };
}
