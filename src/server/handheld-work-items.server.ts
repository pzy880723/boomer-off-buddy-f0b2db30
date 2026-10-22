import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { effectiveLocationIds, type NotificationScope } from './handheld-notifications.server';
import {decodeWorkCursor,encodeWorkCursor,parseWorkCounts,type WorkItem} from '@/lib/handheld/work-items';
import {loadMeasurementCards,loadMeasurementSkuThumbnails} from './support-measurement.server';
export async function loadPendingCounts(scope:NotificationScope) {
 const {data,error}=await supabaseAdmin.rpc('handheld_pending_counts',{p_user_id:scope.user_id,p_location_ids:effectiveLocationIds(scope),p_include_unlocated:scope.is_hq && !scope.filter_location_id});
 if(error) throw new Error('pending_counts_unavailable'); return parseWorkCounts(data);
}
export async function loadWorkItems(scope:NotificationScope,limit=50,cursor?:string,opts?:{includeIgnored?:boolean;ignoredOnly?:boolean}) {
 const parsed=decodeWorkCursor(cursor);
 const {data,error}=await supabaseAdmin.rpc('handheld_work_items',{p_user_id:scope.user_id,p_location_ids:effectiveLocationIds(scope),p_include_unlocated:scope.is_hq && !scope.filter_location_id,
   p_limit:limit,p_cursor_ts:parsed?.ts,p_cursor_id:parsed?.id,
   p_include_ignored:opts?.includeIgnored===true,p_ignored_only:opts?.ignoredOnly===true});
 if(error || !data || typeof data!=='object' || Array.isArray(data)) throw new Error('work_items_unavailable');
 const raw=data as {items:WorkItem[];counts:unknown;has_more:boolean;last_ts:string|null;last_id:string|null};
 if(!Array.isArray(raw.items)) throw new Error('work_items_contract_error');
 const items=await Promise.all(raw.items.map(async row=> {
   let image_url:string|null=null;
   if(row.conversation_id && row.sku_id) {
     const conv=await supabaseAdmin.from('support_conversations').select('id,customer_id,location_id').eq('id',row.conversation_id).maybeSingle();
    if(conv.error) throw new Error('work_items_unavailable');
    if(conv.data && (scope.is_hq || (conv.data.location_id && effectiveLocationIds(scope).includes(conv.data.location_id)))) {
     const req=await supabaseAdmin.from('product_measurement_requesters').select('task_id').eq('conversation_id',row.conversation_id);
     if(req.error) throw new Error('work_items_unavailable');
     const cards=await loadMeasurementCards(conv.data,(req.data??[]).map(q=>q.task_id));
     image_url=[...cards.values()].find(c=>c.sku_id===row.sku_id)?.image_url ?? null;
    }
   }
   return {id:row.id,type:row.type,title:row.title,description:row.description,meta:null,urgency:'normal' as const,action:row.action,target_id:row.target_id,
     sku_id:row.sku_id??null,conversation_id:row.conversation_id??null,image_url,
    measurement_task_id:row.measurement_task_id??null,measurement_request_version:row.measurement_request_version??null,
    can_ignore:row.can_ignore===true,ignored:row.ignored===true,can_restore:row.can_restore===true};
 }));
 // 逐任务测量行（conversation_id 为 NULL）的缩略图：RPC 已按 scope 授权，这里批量签派生缩略图，不回原图。
 const thumbSkuIds=[...new Set(items.filter(it=>it.measurement_task_id && !it.image_url && it.sku_id).map(it=>it.sku_id!))];
 if(thumbSkuIds.length) {
   const thumbs=await loadMeasurementSkuThumbnails(thumbSkuIds);
   for(const it of items) if(it.measurement_task_id && !it.image_url && it.sku_id) it.image_url=thumbs.get(it.sku_id) ?? null;
 }
 return {items,counts:parseWorkCounts(raw.counts),next_cursor:raw.has_more && raw.last_ts && raw.last_id ? encodeWorkCursor(raw.last_ts,raw.last_id) : null};
}
