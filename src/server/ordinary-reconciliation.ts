export interface ReconciliationItem { id: string; kind: string }
export async function runOrdinaryReconciliation<T extends ReconciliationItem>(deps: {
  list(): Promise<T[]>; reconcile(item: T): Promise<unknown>; markChecked(item: T): Promise<unknown>;
}) {
  const items = (await deps.list()).slice(0, 40);
  let next = 0; let succeeded = 0; let failed = 0;
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      let success = false;
      try { await deps.reconcile(item); success = true; } catch { /* Next tick retries the original ID. */ }
      try { await deps.markChecked(item); } catch { success = false; }
      if (success) succeeded++; else failed++;
    }
  }));
  return { attempted: items.length, succeeded, failed };
}
