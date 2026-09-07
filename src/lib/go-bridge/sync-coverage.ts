export type CompletedScan = {
  window_start: string;
  window_end: string;
  last_completed_scan_end: string | null;
  last_completed_at: string | null;
};

/** The cron interval is 30 minutes; allow one run plus 15 minutes of processing.
 * This proves update-window coverage only, not full historical/refund coverage.
 */
export function completedSyncCoverage(input: {
  rows: CompletedScan[];
  startUtc: string;
  endUtc: string;
  now: Date;
}) {
  const start = Date.parse(input.startUtc);
  const end = Date.parse(input.endUtc);
  const now = input.now.getTime();
  const intervals = input.rows.flatMap((row) => {
    const from = Date.parse(row.window_start);
    const windowEnd = Date.parse(row.window_end);
    const through = Date.parse(row.last_completed_scan_end ?? "");
    const completed = Date.parse(row.last_completed_at ?? "");
    if (![from, windowEnd, through, completed].every(Number.isFinite) ||
        through <= from || through > windowEnd || through > now ||
        completed < through || completed > now) return [];
    return [[from, through] as const];
  }).sort((a, b) => a[0] - b[0]);
  let through = start;
  for (const [from, to] of intervals) {
    if (from > through) break;
    through = Math.max(through, Math.min(to, end));
  }
  const hasSnapshot = Number.isFinite(start) && Number.isFinite(end) &&
    end > start && now >= start && through > start;
  const wholeDayCovered = hasSnapshot && now >= end && through >= end;
  return {
    syncedThrough: hasSnapshot ? new Date(through).toISOString() : null,
    hasSnapshot,
    fresh: hasSnapshot && (now >= end ? wholeDayCovered : through >= now - 45 * 60_000),
    wholeDayCovered,
  };
}
