// 批量修改特色印章 / 提示标签 / 翻筐乐的纯规则：只算目标字段，结果逐件 apply/unchanged/skipped。
import {
  EXCLUSIVE_NOTICE_TAGS, FEATURED_STAMPS, NOTICE_TAGS, normalizeNoticeTags, readProductMarks,
  type FeaturedStamp, type NoticeTag,
} from "./product-marks.ts";
import { isFankuangEligibleSku } from "./fankuang.ts";

export type BatchMarkOp =
  | { kind: "notice"; add: NoticeTag[]; remove: NoticeTag[] }
  | { kind: "stamp"; value: FeaturedStamp | null }
  | { kind: "fankuang"; value: boolean | null };

export type BatchSkuState = {
  status?: string | null;
  is_custom_price?: boolean | null;
  kind?: string | null;
  inventory_policy?: string | null;
  stock_qty?: number | string | null;
  price_tier?: number | string | null;
  featured_stamp?: unknown;
  notice_tags?: unknown;
  fankuang_override?: boolean | null;
};

export type SkipReason = "archived" | "flawed_requires_annotation" | "function_conflict" | "fankuang_not_applicable" | "sold_out";
export const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  archived: "商品已归档",
  flawed_requires_annotation: "“有瑕疵”需在商品详情逐件圈选图片后添加",
  function_conflict: "“功能不确定”与“功能不可用”冲突，请同时移除另一项或跳过",
  fankuang_not_applicable: "仅自定义单件商品可参与翻筐乐",
  sold_out: "已售罄",
};

export type MarkPlan =
  | { outcome: "apply"; patch: Record<string, unknown>; reason?: undefined }
  | { outcome: "unchanged"; reason?: undefined }
  | { outcome: "skipped"; reason: SkipReason };

export function isValidBatchOp(op: BatchMarkOp): boolean {
  if (op.kind === "notice") {
    const all = [...op.add, ...op.remove];
    return all.length > 0 && all.every((t) => (NOTICE_TAGS as readonly string[]).includes(t))
      && !op.add.some((t) => op.remove.includes(t))
      && !EXCLUSIVE_NOTICE_TAGS.every((t) => op.add.includes(t));
  }
  if (op.kind === "stamp") return op.value === null || (FEATURED_STAMPS as readonly string[]).includes(op.value);
  return op.value === null || typeof op.value === "boolean";
}

export function planMarkChange(sku: BatchSkuState, op: BatchMarkOp): MarkPlan {
  if ((sku.status ?? "active") !== "active") return { outcome: "skipped", reason: "archived" };
  const cur = readProductMarks(sku);
  if (op.kind === "notice") {
    const adding = op.add.filter((t) => !cur.notice_tags.includes(t));
    if (adding.includes("flawed")) return { outcome: "skipped", reason: "flawed_requires_annotation" };
    const next = normalizeNoticeTags([...cur.notice_tags.filter((t) => !op.remove.includes(t)), ...adding]);
    if (EXCLUSIVE_NOTICE_TAGS.every((t) => next.includes(t))) return { outcome: "skipped", reason: "function_conflict" };
    if (next.join() === cur.notice_tags.join()) return { outcome: "unchanged" };
    return { outcome: "apply", patch: { notice_tags: next } };
  }
  if (op.kind === "stamp") {
    if (cur.featured_stamp === op.value) return { outcome: "unchanged" };
    return { outcome: "apply", patch: { featured_stamp: op.value } };
  }
  if (!isFankuangEligibleSku(sku)) return { outcome: "skipped", reason: "fankuang_not_applicable" };
  if (op.value === true && !(Number(sku.stock_qty) > 0)) return { outcome: "skipped", reason: "sold_out" };
  if ((sku.fankuang_override ?? null) === op.value) return { outcome: "unchanged" };
  return { outcome: "apply", patch: { fankuang_override: op.value } };
}
