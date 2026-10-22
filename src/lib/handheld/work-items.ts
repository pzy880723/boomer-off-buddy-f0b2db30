import { z } from 'zod';
import { parseUnreadCounts, type UnreadCounts } from './unread-counts';
const uuid = z.string().uuid();
// include_ignored / ignored_only：测量个人忽略的可选视图参数；只接受字面 "true"，旧客户端不传即 false。
const trueFlag = z.literal('true').transform(() => true as boolean);
export const workItemsInput = z.object({
  location_id: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(160).optional(),
  include_ignored: trueFlag.optional().catch(undefined).transform(v => v === true),
  ignored_only: trueFlag.optional().catch(undefined).transform(v => v === true),
}).strict();
export function decodeWorkCursor(cursor?:string): {ts:string;id:string}|null {
 if(!cursor) return null;
 const parts=cursor.split('|');
 if(parts.length!==2 || !uuid.safeParse(parts[1]).success || !/^\d{4}-\d\d-\d\dT/.test(parts[0]) || !Number.isFinite(Date.parse(parts[0]))) throw new Error('invalid_cursor');
 return {ts:parts[0],id:parts[1]};
}
export type WorkItem={
 id:string;type:string;title:string;description:string;meta:string|null;urgency?:'normal'|'urgent';
 action:string;target_id:string;sku_id?:string|null;conversation_id?:string|null;image_url?:string|null;
 /** 测量行专有：任务 id / 请求版本（含微秒的时间戳字符串）/ 当前员工可否忽略 / 是否已被本人忽略。 */
 measurement_task_id?:string|null;measurement_request_version?:string|null;can_ignore?:boolean;ignored?:boolean;
};
export function parseWorkCounts(raw:unknown):UnreadCounts {
 const parsed=parseUnreadCounts(raw); if(!parsed.ok) throw new Error('pending_counts_contract_error'); return parsed.data;
}
