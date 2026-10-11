// 纯解析（无服务端依赖），便于单测。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseListCursor(cursor: string): { ts: string; id: string } | null {
  const [ts, id, extra] = cursor.split("|");
  if (extra !== undefined || !ts || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(ts))) return null;
  return { ts: new Date(ts).toISOString(), id };
}

/** 变更游标 "v2:<xid>:<seq>"；"latest" 表示从当前水位开始（不回放历史）。 */
export function parseChangeCursor(cursor: string): { xid: string; seq: number } | "latest" | null {
  if (cursor === "latest") return "latest";
  const m = /^v2:(\d{1,20}):(\d{1,19})$/.exec(cursor);
  return m ? { xid: m[1], seq: Number(m[2]) } : null;
}

