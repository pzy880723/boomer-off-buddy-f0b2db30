import {createFileRoute} from '@tanstack/react-router';
import {HANDHELD_CORS,authenticateDevice,resolveSessionUser,ok,err} from '@/server/handheld-auth.server';
import {resolveNotificationScope,applyRequestedLocation} from '@/server/handheld-notifications.server';
import {workItemsInput,decodeWorkCursor} from '@/lib/handheld/work-items';
export const Route=createFileRoute('/api/public/handheld/work-items')({server:{handlers:{
 OPTIONS:async()=>new Response(null,{status:204,headers:HANDHELD_CORS}),
 GET:async({request})=>{
  const auth=await authenticateDevice(request);if(!auth.ok)return auth.response;
  const session=await resolveSessionUser(request);if(!session)return err('Employee session required',401,{code:'session_required'});
  const input=workItemsInput.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if(!input.success)return err('Invalid query',400,{code:'validation_error'});
  try{decodeWorkCursor(input.data.cursor);}catch{return err('Invalid cursor',400,{code:'invalid_cursor'});}
  const base=await resolveNotificationScope({userId:session.user_id,deviceId:auth.device.id,deviceLocationId:auth.device.location_id});
  const scoped=applyRequestedLocation(base,input.data.location_id);
  if(!scoped.ok)return err('Location not authorized',403,{code:'location_forbidden'});
  try{const {loadWorkItems}=await import('@/server/handheld-work-items.server');return ok(await loadWorkItems(scoped.scope,input.data.limit,input.data.cursor));}
  catch(error){console.error('[work-items]',error instanceof Error?error.message:'unavailable');return err('Work items temporarily unavailable',500,{code:'work_items_unavailable'});}
 }
}}});
