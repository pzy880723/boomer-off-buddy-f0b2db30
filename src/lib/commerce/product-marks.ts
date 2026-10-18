// 商品特色印章（单选，可清空）与提示标签（多选，可空）。唯一字典：值为存储键，界面只显示中文标签。
// 规则：function_uncertain 与 function_unavailable 互斥；均非必填，旧商品默认无标记。
import * as z from "zod";

export const FEATURED_STAMPS = ["new", "rare", "limited", "collectible", "discontinued"] as const;
export type FeaturedStamp = (typeof FEATURED_STAMPS)[number];
export const FEATURED_STAMP_LABELS: Record<FeaturedStamp, string> = {
  new: "全新品",
  rare: "稀有商品",
  limited: "限定版",
  collectible: "收藏级",
  discontinued: "绝版商品",
};

export const NOTICE_TAGS = ["flawed", "function_uncertain", "function_unavailable", "not_edible"] as const;
export type NoticeTag = (typeof NOTICE_TAGS)[number];
export const NOTICE_TAG_LABELS: Record<NoticeTag, string> = {
  flawed: "有瑕疵",
  function_uncertain: "功能不确定",
  function_unavailable: "功能不可用",
  not_edible: "不可食用",
};
export const EXCLUSIVE_NOTICE_TAGS: readonly [NoticeTag, NoticeTag] = ["function_uncertain", "function_unavailable"];

export const FeaturedStampSchema = z.enum(FEATURED_STAMPS).nullable();
export const NoticeTagsSchema = z
  .array(z.enum(NOTICE_TAGS))
  .max(NOTICE_TAGS.length)
  .refine((v) => new Set(v).size === v.length, "提示标签不能重复")
  .refine((v) => !EXCLUSIVE_NOTICE_TAGS.every((t) => v.includes(t)), "“功能不确定”与“功能不可用”只能选一个");

/** 统一输出顺序（按字典顺序），便于比较是否变化。 */
export function normalizeNoticeTags(v: readonly NoticeTag[]): NoticeTag[] {
  return NOTICE_TAGS.filter((t) => v.includes(t));
}

/** DTO 读取：未知值一律丢弃，绝不外泄非字典键。 */
export function readProductMarks(sku: { featured_stamp?: unknown; notice_tags?: unknown } | null | undefined) {
  const stamp = typeof sku?.featured_stamp === "string" && (FEATURED_STAMPS as readonly string[]).includes(sku.featured_stamp)
    ? (sku.featured_stamp as FeaturedStamp) : null;
  const raw = Array.isArray(sku?.notice_tags) ? sku!.notice_tags as unknown[] : [];
  const tags = normalizeNoticeTags(raw.filter((t): t is NoticeTag => (NOTICE_TAGS as readonly unknown[]).includes(t)));
  return { featured_stamp: stamp, notice_tags: tags };
}
