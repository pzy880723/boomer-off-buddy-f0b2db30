import { z } from 'zod';
import { parseUnreadCounts, type UnreadCounts } from './unread-counts';
const uuid = z.string().uuid();
export const workItemsInput = z.object({location_id:uuid.optional(),limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().max(160).optional()}).strict();
export function decodeWorkCursor(cursor?:string): {ts:string;id:string}|null {
 if(!cursor) return null;
 const parts=cursor.split('|');
 if(parts.length!==2 || !uuid.safeParse(parts[1]).success || !/^\d{4}-\d\d-\d\dT/.test(parts[0]) || !Number.isFinite(Date.parse(parts[0]))) throw new Error('invalid_cursor');
 return {ts:parts[0],id:parts[1]};
}
export type WorkItem={id:string;type:string;title:string;description:string;meta:string|null;urgency?:'normal'|'urgent';action:string;target_id:string;sku_id?:string|null;conversation_id?:string|null;image_url?:string|null};
export function parseWorkCounts(raw:unknown):UnreadCounts {
 const parsed=parseUnreadCounts(raw); if(!parsed.ok) throw new Error('pending_counts_contract_error'); return parsed.data;
}
