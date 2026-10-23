export const MELUO_SHOP_ID='d49226af-06b9-4cae-b878-81d580db81f0';
export const MELUO_KDT=215098500;
export const STANDARD_HQ_KDT=153242272;
export function assertMeluoTarget(s:{id:string;kdt_id:number;parent_kdt_id:number|null;role:string;status:string;warehouse_code:string|null}) {
 if(s.id!==MELUO_SHOP_ID || Number(s.kdt_id)!==MELUO_KDT || Number(s.parent_kdt_id)!==STANDARD_HQ_KDT || s.role!=='branch'||s.status!=='active'||s.warehouse_code!=='MD00004')throw Error('target_mismatch');
}
export function buildMeluoChannelAppend(spuId:number,channelId:number,evidence?:{officialSemanticsVerified:boolean;currentChannelsComplete:boolean;currentChannelIds:number[]}) {
 if(!Number.isSafeInteger(spuId)||spuId<=0||!Number.isSafeInteger(channelId)||channelId<=0)throw Error('verified_identity_required');
 if(!evidence?.officialSemanticsVerified||!evidence.currentChannelsComplete)throw Error('official_semantics_and_complete_channels_required');
 if(evidence.currentChannelIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error('invalid_existing_channel');
 return {spu_id:spuId,sell_channel_setting_request:{is_partial:1,sell_channel_ids:[...new Set([...evidence.currentChannelIds,channelId])]}};
}
export function assertMeluoChannelReadback(expected:number[],actual:number[],complete:boolean) {
 if(!complete||expected.some(id=>!actual.includes(id)))throw Error('existing_channel_readback_required');
}
export function validateMeluoCatalog(groups:Array<{skus:Array<{id:string;barcode:string|null}>;spuIds:number[]}>) {
 if(groups.length!==14||groups.some(g=>g.skus.length!==32||new Set(g.spuIds).size!==1||g.spuIds.some(x=>!Number.isSafeInteger(x)||x<=0)))throw Error('catalog_14x32_hq_links_required');
 const ids=groups.flatMap(g=>g.skus.map(s=>s.id));const bars=groups.flatMap(g=>g.skus.map(s=>s.barcode));
 if(new Set(ids).size!==448||new Set(bars).size!==448||bars.some(b=>!b))throw Error('catalog_identity_mismatch');
}