import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { cardAuthorized, safeMeasurementImage, type MeasurementCard, type CardTask } from '@/lib/measurement-card';
import { loadConversationThumbnails } from './support-thumbnails.server';
import { resolveItemImageRef } from './storefront-order-list.server';
type Conversation = {id:string;customer_id:string|null;location_id:string|null};
/** Only called after exact conversation authorization. Task/store/requester are rechecked before images. */
export async function loadMeasurementCards(conversation: Conversation, taskIds: string[]): Promise<Map<string,MeasurementCard>> {
  const cards = new Map<string,MeasurementCard>();
  if (!taskIds.length || !conversation.customer_id) return cards;
  const [tasks,requesters] = await Promise.all([
    supabaseAdmin.from('product_measurement_tasks').select('id,sku_id,listing_id,location_id,status').in('id',taskIds),
    supabaseAdmin.from('product_measurement_requesters').select('task_id,customer_id,conversation_id').eq('customer_id',conversation.customer_id).eq('conversation_id',conversation.id).in('task_id',taskIds),
  ]);
  if (tasks.error || requesters.error) throw new Error('measurement_card_unavailable');
  const allowed = (tasks.data ?? []).filter(t=>cardAuthorized(t as CardTask,conversation,requesters.data ?? []));
  if (!allowed.length) return cards;
  const skus = await supabaseAdmin.from('inv_skus').select('id,name,measurement_revision,measured_at,measurement_height_cm,measurement_width_cm,measurement_depth_cm,measurement_diameter_cm').in('id',[...new Set(allowed.map(t=>t.sku_id))]);
  if(skus.error) throw new Error('measurement_card_unavailable');
  const images = await loadConversationThumbnails(allowed.map(t=>({id:t.id,context:{type:'product',id:t.listing_id}})),conversation.customer_id);
  for(const t of allowed) {
    const sku = skus.data?.find(s=>s.id===t.sku_id);
    if(!sku || !['pending','claimed','completed','cancelled'].includes(t.status)) continue;
    cards.set(t.id,{task_id:t.id,sku_id:t.sku_id,listing_id:t.listing_id,product_name:sku.name ?? '商品',
      image_url:safeMeasurementImage(images.get(t.id)),status:t.status as MeasurementCard['status'],measurement_revision:sku.measurement_revision,
      ...(sku.measured_at ? {measurement:{height_cm:sku.measurement_height_cm,width_cm:sku.measurement_width_cm,depth_cm:sku.measurement_depth_cm,diameter_cm:sku.measurement_diameter_cm}} : {}),
    });
  }
  return cards;
}
/** 待办测量行（无客服会话）的缩略图：仅 SKU image_paths/image_url 的派生缩略图，批量签名，永不回原图或对象 key。 */
export async function loadMeasurementSkuThumbnails(skuIds: readonly string[]): Promise<Map<string,string|null>> {
  const out = new Map<string,string|null>(skuIds.map(id=>[id,null]));
  if (!skuIds.length) return out;
  const {data,error} = await supabaseAdmin.from('inv_skus').select('id,image_paths,image_url').in('id',[...new Set(skuIds)]);
  if (error) throw new Error('measurement_thumb_unavailable');
  const refOf = new Map<string,string>();
  for (const s of data ?? []) {
    const ref = resolveItemImageRef({sku:s} as never);
    if (ref?.kind==='path') refOf.set(String(s.id), ref.value);
  }
  const paths=[...new Set(refOf.values())];
  if (!paths.length) return out;
  const {DERIVATIVE_WIDTHS,signDerivativeUrls}=await import('./media-derivative.server');
  let signed:(string|null)[];
  try { signed=await signDerivativeUrls(paths,DERIVATIVE_WIDTHS.thumbnail); } catch { return out; }
  const byPath=new Map(paths.map((p,i)=>[p,signed[i]??null]));
  for (const [id,p] of refOf) out.set(id,byPath.get(p)??null);
  return out;
}
export async function pendingConversationStates(ids: string[]) {
  return new Map(await Promise.all(ids.map(async id=> {
    const {data,error}=await supabaseAdmin.rpc('support_pending_state' as never,{p_conversation_id:id} as never);
    if(error) throw new Error('support_pending_unavailable');
    return [id,data as {needs_reply:boolean;pending_measurement_count:number;pending_action:boolean}] as const;
  })));
}

// ===== 生产 scoped 待办基线使用的批量卡片/缩略图 helper（与线上 support-measurement 同源） =====
export type SupportMeasurementCard = {
  task_id: string;
  sku_id: string;
  listing_id: string | null;
  product_name: string;
  image_url: string | null;
  status: "pending" | "claimed" | "completed" | "cancelled";
  measurement_revision: number;
  measurement?: { height_cm: number | null; width_cm: number | null; depth_cm: number | null; diameter_cm: number | null };
};

type CardMessage = { id: string; measurement_task_id?: string | null; card_kind?: string | null; internal?: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CardDeps = { client?: { from: (name: string) => any }; sign?: (paths: readonly string[]) => Promise<(string | null)[]> };
type ThumbSku = { id: string; name?: string | null; image_paths?: unknown; image_url?: string | null;
  measurement_revision?: number; measurement_height_cm?: number | null; measurement_width_cm?: number | null;
  measurement_depth_cm?: number | null; measurement_diameter_cm?: number | null };

/** Only server-derived derivatives leave this module, never raw private object keys or originals. */
export async function measurementThumbnails(skus: readonly ThumbSku[], sign?: CardDeps["sign"]) {
  const refs = new Map(skus.map((sku) => [sku.id, resolveItemImageRef({ id: sku.id, sku } as never)]));
  const paths = [...new Set([...refs.values()].filter((ref) => ref?.kind === "path").map((ref) => ref!.value))];
  let urls: (string | null)[] = [];
  try {
    if (paths.length) {
      if (sign) urls = await sign(paths);
      else {
        const { signDerivativeUrls, DERIVATIVE_WIDTHS } = await import("./media-derivative.server");
        urls = await signDerivativeUrls(paths, DERIVATIVE_WIDTHS.thumbnail);
      }
    }
  } catch { /* Image failure must not hide the customer's actionable request. */ }
  const signed = new Map(paths.map((path, i) => [path, urls[i] ?? null]));
  return new Map(skus.map((sku) => {
    const ref = refs.get(sku.id);
    return [sku.id, ref?.kind === "path" ? signed.get(ref.value) ?? null : null];
  }));
}

/** Caller authorizes this exact conversation first. Recheck requester + store before any SKU/media read. */
export async function loadSupportMeasurementCards(conversation: Conversation, messages: readonly CardMessage[], deps: CardDeps = {}): Promise<Map<string, SupportMeasurementCard>> {
  const out = new Map<string, SupportMeasurementCard>();
  const source = messages.filter((m) => m.measurement_task_id && !m.internal &&
    (m.card_kind === "measurement_request" || m.card_kind === "measurement_completed"));
  if (!source.length || !conversation.customer_id || !conversation.location_id) return out;
  const client = deps.client ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  const ids = [...new Set(source.map((m) => m.measurement_task_id!))];
  const [tasks, links] = await Promise.all([
    client.from("product_measurement_tasks").select("id,sku_id,listing_id,location_id,status").in("id", ids),
    client.from("product_measurement_requesters").select("task_id,customer_id,conversation_id")
      .eq("customer_id", conversation.customer_id).eq("conversation_id", conversation.id).in("task_id", ids),
  ]);
  if (tasks.error || links.error) throw new Error("measurement_card_read_failed");
  const linked = new Set((links.data ?? []).filter((r: any) => r.customer_id === conversation.customer_id && r.conversation_id === conversation.id).map((r: any) => r.task_id));
  const authorized = (tasks.data ?? []).filter((t: any) => linked.has(t.id) && t.location_id === conversation.location_id &&
    ["pending", "claimed", "completed", "cancelled"].includes(t.status));
  if (!authorized.length) return out;
  const skus = await client.from("inv_skus").select("id,name,image_paths,image_url,measurement_revision,measurement_height_cm,measurement_width_cm,measurement_depth_cm,measurement_diameter_cm")
    .in("id", [...new Set(authorized.map((t: any) => t.sku_id))]);
  if (skus.error) throw new Error("measurement_card_read_failed");
  const skuMap = new Map<string, ThumbSku>((skus.data ?? []).map((s: ThumbSku) => [s.id, s]));
  const images = await measurementThumbnails([...skuMap.values()], deps.sign);
  const taskMap = new Map<string, any>(authorized.map((t: any) => [t.id, t]));
  for (const message of source) {
    const task = taskMap.get(message.measurement_task_id!);
    const sku = task ? skuMap.get(task.sku_id) : null;
    if (!task || !sku) continue;
    out.set(message.id, {
      task_id: task.id, sku_id: sku.id, listing_id: task.listing_id ?? null,
      product_name: sku.name || "待测量商品", image_url: images.get(sku.id) ?? null,
      status: task.status, measurement_revision: sku.measurement_revision ?? 0,
      measurement: { height_cm: sku.measurement_height_cm ?? null, width_cm: sku.measurement_width_cm ?? null,
        depth_cm: sku.measurement_depth_cm ?? null, diameter_cm: sku.measurement_diameter_cm ?? null },
    });
  }
  return out;
}
