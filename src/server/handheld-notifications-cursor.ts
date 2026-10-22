// 纯解析（无服务端依赖），便于单测。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseListCursor(cursor: string): { ts: string; id: string } | null {
  const [ts, id, extra] = cursor.split("|");
  if (extra !== undefined || !ts || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(ts))) return null;
  // 保留原始时间戳字符串（含微秒）：PostgREST 按文本比较 timestamptz，
  // 经 Date 往返会截断到毫秒，同一毫秒内不同微秒的行会被跳过。
  return { ts, id };
}

/** 变更游标 "v2:<xid>:<seq>"；"latest" 表示从当前水位开始（不回放历史）。 */
export function parseChangeCursor(cursor: string): { xid: string; seq: number } | "latest" | null {
  if (cursor === "latest") return "latest";
  const m = /^v2:(\d{1,20}):(\d{1,19})$/.exec(cursor);
  return m ? { xid: m[1], seq: Number(m[2]) } : null;
}


/**
 * 同步失败恢复投影的触发条件：仅通知列表首次页（无游标）且全部分类或 system 分类时
 * 触发一次 handheld_sync_failure_reconcile；其他分类与后续分页不额外扫描。
 */
export function shouldReconcileSyncFailures(
  cursor: string | null | undefined,
  category: string | null | undefined,
): boolean {
  return !cursor && (!category || category === "system");
}
