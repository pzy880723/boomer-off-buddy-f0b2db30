import { FEATURED_STAMPS, type FeaturedStamp } from "./product-marks.ts";
import type { BatchMarkOp } from "./product-marks-batch.ts";

export type ConfirmedBatch = { location_id: string; op: BatchMarkOp; items: Array<{ id: string; expected_updated_at: string }> };
export function stampOperation(value: FeaturedStamp | "nochange" | "clear" | ""): BatchMarkOp | null {
  if (value === "clear") return { kind: "stamp", value: null };
  return (FEATURED_STAMPS as readonly string[]).includes(value) ? { kind: "stamp", value: value as FeaturedStamp } : null;
}
export function confirmBatch(location_id: string, op: BatchMarkOp, items: ConfirmedBatch["items"]): ConfirmedBatch {
  return structuredClone({ location_id, op, items });
}
export function retryBatch(confirmed: ConfirmedBatch, results: Array<{ id: string; result: string; updated_at?: string }>): ConfirmedBatch {
  const failed = new Set(results.filter((r) => r.result === "failed").map((r) => r.id));
  return confirmBatch(confirmed.location_id, confirmed.op, confirmed.items.filter((i) => failed.has(i.id)));
}
export class BatchReceiptFence {
  private generation = 0;
  begin(context: string) { return { generation: ++this.generation, context }; }
  invalidate() { ++this.generation; }
  accept(ticket: { generation: number; context: string }, context: string) {
    return ticket.generation === this.generation && ticket.context === context;
  }
}

export function batchPatchReturned(patch: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.entries(patch).every(([key, value]) => JSON.stringify(row[key]) === JSON.stringify(value));
}

/** Normalize offsets at whole-second precision; preserve all fractional digits up to nanoseconds. */
export function sameBatchVersion(a: string, b: string): boolean {
  const normalize = (s: string) => {
    const match = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(s);
    if (!match) return null;
    const seconds = Date.parse(`${match[1].replace(" ", "T")}${match[3]}`);
    return Number.isFinite(seconds) ? `${seconds}:${(match[2] ?? "").padEnd(9, "0")}` : null;
  };
  const first = normalize(a);
  return first !== null && first === normalize(b);
}