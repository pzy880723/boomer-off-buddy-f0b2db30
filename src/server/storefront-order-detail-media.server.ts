/**
 * 订单详情展示图收敛：把 items[].image_snapshot 替换成真实 480px 衍生图，
 * 无法安全转换（外域、data:、未知桶、签名失败）一律 null，绝不回退原图。
 * 不改动订单归属过滤、金额、状态或其他任何字段。
 */
import { DERIVATIVE_WIDTHS, signDerivativeUrls } from "./media-derivative.server";

export type OrderDetailSigner = (values: readonly string[]) => Promise<(string | null)[]>;

type UnknownRecord = Record<string, unknown>;

export async function withOrderItemThumbnails<T>(
  order: T,
  signer: OrderDetailSigner = (values) => signDerivativeUrls(values, DERIVATIVE_WIDTHS.thumbnail),
): Promise<T> {
  const row = order as unknown as UnknownRecord | null;
  if (!row || typeof row !== "object") return order;
  const items = row["items"];
  if (!Array.isArray(items) || items.length === 0) return order;

  const values = items.map((item) => {
    const snapshot = (item as UnknownRecord | null)?.["image_snapshot"];
    return typeof snapshot === "string" ? snapshot : "";
  });

  let signed: (string | null)[] = [];
  try {
    signed = await signer(values);
  } catch {
    signed = [];
  }

  return {
    ...(row as UnknownRecord),
    items: items.map((item, i) => ({
      ...(item as UnknownRecord),
      image_snapshot: signed[i] ?? null,
    })),
  } as unknown as T;
}
