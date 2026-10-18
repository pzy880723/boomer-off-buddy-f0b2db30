import {createServerFn} from '@tanstack/react-start';
import {requireSupabaseAuth} from '@/integrations/supabase/auth-middleware';
import {z} from 'zod';
export const getWorkItemsFn=createServerFn({method:'GET'}).middleware([requireSupabaseAuth]).inputValidator((raw:unknown)=>z.object({locationId:z.string().uuid().optional(),cursor:z.string().max(160).optional()}).strict().parse(raw??{})).handler(async({data,context})=>{
 const {dashboardScope}=await import('@/server/operational-dashboard.server');
 const scope=await dashboardScope(context.userId);
 if(data.locationId && !scope.locations.some(l=>l.id===data.locationId))throw new Error('无该门店权限');
 const {loadWorkItems}=await import('@/server/handheld-work-items.server');
 return loadWorkItems({user_id:context.userId,device_id:'',device_location_id:null,location_ids:scope.locations.map(l=>l.id),is_hq:scope.isHq,filter_location_id:data.locationId},50,data.cursor);
});
