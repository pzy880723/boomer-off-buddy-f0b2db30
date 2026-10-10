// 小程序热门发现：纯函数（请求校验、搜索词表匹配、热门排序）。服务端写库见 storefront-engagement.server.ts。
import { z } from "zod";

export const ENGAGEMENT_WINDOW_DAYS = 30;
export const FAVORITE_WEIGHT = 3;

export const EngagementBody = z
  .object({
    kind: z.enum(["open", "favorite", "search"]),
    product_id: z.string().uuid().optional(),
    query: z.string().max(40).optional(),
    selected: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.kind === "open" || v.kind === "favorite") && !v.product_id)
      ctx.addIssue({ code: "custom", message: "product_id required" });
    if (v.kind === "favorite" && typeof v.selected !== "boolean")
      ctx.addIssue({ code: "custom", message: "selected required" });
    if (v.kind === "search" && !v.query?.trim())
      ctx.addIssue({ code: "custom", message: "query required" });
  });
export type EngagementInput = z.infer<typeof EngagementBody>;

export type VocabularyTerm = { key: string; label: string; query: string; aliases: string[] };

export function normalizeTerm(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** 只认词表里的品牌/标签/品类；手机号、长数字串、其他自由文本一律不记录。 */
export function matchVocabulary(query: string, vocabulary: readonly VocabularyTerm[]): VocabularyTerm | null {
  const q = normalizeTerm(query);
  if (!q || q.length > 40 || /\d{5,}/.test(q.replace(/[\s-]/g, ""))) return null;
  for (const term of vocabulary) {
    if ([term.label, term.query, ...term.aliases].some((v) => v && normalizeTerm(v) === q)) return term;
  }
  return null;
}

export function popularScore(c: { view_count: number; favorite_count: number }): number {
  return c.view_count + FAVORITE_WEIGHT * c.favorite_count;
}

/** 按热度降序；零分或同分按 published_at 新→旧，再按 id 稳定。 */
export function sortByPopular<T extends { id: string; published_at: string | null; view_count: number; favorite_count: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      popularScore(b) - popularScore(a) ||
      String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")) ||
      a.id.localeCompare(b.id),
  );
}
