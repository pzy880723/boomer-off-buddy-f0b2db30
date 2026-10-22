// ERP 批量印章/提示/翻筐乐：逐件授权 + 逐件 CAS（updated_at）只写目标字段；结果逐件返回，不假成功。
import { isValidBatchOp, planMarkChange, type BatchMarkOp, type BatchSkuState, type SkipReason } from "../lib/commerce/product-marks-batch.ts";

export type BatchItemInput = { id: string; expected_updated_at: string };
export type BatchItemResult = {
  id: string;
  result: "success" | "unchanged" | "skipped" | "failed";
  reason?: SkipReason | "no_permission" | "not_found" | "version_conflict" | "write_failed";
  updated_at?: string;
  changed_fields?: string[];
};
export type BatchActor = { hq: boolean; managerLocationIds: string[] };
export type BatchSkuRow = BatchSkuState & { id: string; updated_at: string };

export type BatchDeps = {
  loadSkus(ids: string[]): Promise<BatchSkuRow[]>;
  /** 店长：返回在给定门店（当前店或其全部授权店）有库存记录的 SKU id。 */
  skusAtLocations(ids: string[], locationIds: string[]): Promise<Set<string>>;
  /** CAS 写入：仅当 updated_at 仍等于 expected 时更新；返回新 updated_at 或 null（冲突）。 */
  casUpdate(id: string, expected: string, patch: Record<string, unknown>): Promise<string | null>;
};

const sameVersion = (a: string, b: string) => Math.floor(Date.parse(a)) === Math.floor(Date.parse(b));

export async function runBatchMarks(
  deps: BatchDeps,
  actor: BatchActor,
  input: { op: BatchMarkOp; location_id: string | null; items: BatchItemInput[] },
): Promise<BatchItemResult[]> {
  if (!isValidBatchOp(input.op)) throw new Error("批量操作参数不正确");
  const ids = [...new Set(input.items.map((i) => i.id))];
  const scope = input.location_id ? [input.location_id] : actor.managerLocationIds;
  if (!actor.hq && (scope.length === 0 || !scope.every((l) => actor.managerLocationIds.includes(l)))) {
    return ids.map((id) => ({ id, result: "skipped", reason: "no_permission" }));
  }
  const rows = new Map((await deps.loadSkus(ids)).map((r) => [r.id, r]));
  const allowed = actor.hq ? new Set(ids) : await deps.skusAtLocations(ids, scope);
  const expected = new Map(input.items.map((i) => [i.id, i.expected_updated_at]));
  const out: BatchItemResult[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) { out.push({ id, result: "failed", reason: "not_found" }); continue; }
    if (!allowed.has(id)) { out.push({ id, result: "skipped", reason: "no_permission" }); continue; }
    const plan = planMarkChange(row, input.op);
    if (plan.outcome === "skipped") { out.push({ id, result: "skipped", reason: plan.reason, updated_at: row.updated_at }); continue; }
    if (plan.outcome === "unchanged") { out.push({ id, result: "unchanged", updated_at: row.updated_at }); continue; }
    if (!sameVersion(row.updated_at, expected.get(id)!)) {
      out.push({ id, result: "failed", reason: "version_conflict", updated_at: row.updated_at }); continue;
    }
    try {
      const next = await deps.casUpdate(id, row.updated_at, plan.patch);
      out.push(next
        ? { id, result: "success", updated_at: next, changed_fields: Object.keys(plan.patch) }
        : { id, result: "failed", reason: "version_conflict" });
    } catch {
      out.push({ id, result: "failed", reason: "write_failed" });
    }
  }
  return out;
}
