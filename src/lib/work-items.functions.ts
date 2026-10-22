import {createServerFn} from '@tanstack/react-start';
import {requireSupabaseAuth} from '@/integrations/supabase/auth-middleware';
import {z} from 'zod';
// ERP web 待办与手持同一路径：必须用 resolveWorkScope（general 与 support 门店独立），
// 不能用 dashboardScope 替代——否则 support-only 账号会被挡在待办之外。
export const getWorkItemsFn=createServerFn({method:'GET'}).middleware([requireSupabaseAuth]).inputValidator((raw:unknown)=>z.object({locationId:z.string().uuid().optional(),cursor:z.string().max(160).optional()}).strict().parse(raw??{})).handler(async({data,context})=>{
 const {resolveWorkScope,applyWorkLocation,loadWorkItems}=await import('@/server/handheld-work-items.server');
 const base=await resolveWorkScope({userId:context.userId});
 const applied=applyWorkLocation(base,data.locationId);
 if(!applied.ok)throw new Error(applied.code==='location_forbidden'?'无该门店权限':'参数无效');
 return loadWorkItems(applied.scope,50,data.cursor);
});
