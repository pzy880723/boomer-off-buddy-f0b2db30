// Narrow standalone Tencent workflow. Does not import/call the broad catalog hook.
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {MELUO_SHOP_ID,MELUO_KDT,STANDARD_HQ_KDT,assertMeluoTarget,buildMeluoChannelAppend,validateMeluoCatalog} from '../src/lib/meluo-standard-target';
import {groupStandardCatalogSkus} from '../src/lib/standard-catalog-youzan-sync';
import {youzanFetch} from '../src/lib/youzan-http';

async function main(){
 const mode=process.argv[2]??'dry-run';const receiptPath=process.argv[3];
 if(!['dry-run','canary','all'].includes(mode)||!receiptPath)throw Error('mode_and_receipt_path_required');
 if(process.env.BOOMER_RUNTIME!=='tencent'||!process.env.YOUZAN_PROXY_URL||!process.env.YOUZAN_PROXY_TOKEN)throw Error('tencent_fixed_proxy_required');
 const {supabaseAdmin:db}=await import('../src/integrations/supabase/client.server');
 const {data:shop,error:se}=await db.from('youzan_shops').select('id,kdt_id,parent_kdt_id,role,status,warehouse_code').eq('id',MELUO_SHOP_ID).single();
 if(se||!shop)throw Error('target_read_failed');assertMeluoTarget(shop);
 const {data:hq,error:he}=await db.from('youzan_shops').select('id,kdt_id,access_token,token_expires_at').eq('role','hq').eq('status','active').eq('kdt_id',STANDARD_HQ_KDT).single();
 if(he||!hq?.access_token||Date.parse(hq.token_expires_at??'')<=Date.now()+300000)throw Error('hq_token_needs_onboarding_refresh');
 const token=hq.access_token;
 const call=async(method:string,version:string,params:Record<string,unknown>)=>{
   const r=await youzanFetch(`https://open.youzanyun.com/api/${method}/${version}?access_token=${encodeURIComponent(token)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params),signal:AbortSignal.timeout(20000)});
   const j=await r.json() as {code?:number;success?:boolean;data?:any;response?:any};if(!r.ok||j.success===false||![0,200].includes(Number(j.code)))throw Error('provider_rejected');return j.data??j.response;
 };
 const org=await call('youzan.shop.chain.descendent.organization.list','1.0.1',{});
 const nodes:Array<Record<string,unknown>>=[];const walk=(v:unknown)=>{if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object'){const n=v as Record<string,unknown>;if(Number(n.kdt_id)===MELUO_KDT)nodes.push(n);Object.values(n).forEach(walk);}};walk(org);
 if(nodes.length!==1||Number(nodes[0].parent_kdt_id)!==STANDARD_HQ_KDT||!Number.isSafeInteger(Number(nodes[0].sell_channel_id))||Number(nodes[0].sell_channel_id)<=0)throw Error('independent_channel_unverified');
 const channel=Number(nodes[0].sell_channel_id);
 const rows:any[]=[];
 for(let o=0;;o+=500){const r=await db.from('inv_skus').select('id,sku_code,barcode,name,category,price_tier').eq('kind','single').eq('is_custom_price',false).eq('inventory_policy','unlimited').eq('is_display',true).eq('status','active').order('id').range(o,o+499);if(r.error)throw Error('catalog_read_failed');rows.push(...r.data??[]);if((r.data?.length??0)<500)break;}
 const links:any[]=[];for(let o=0;;o+=500){const r=await db.from('sku_youzan_links').select('sku_id,yz_item_id,yz_sku_id').eq('shop_id',hq.id).eq('role','hq_spu').order('sku_id').range(o,o+499);if(r.error)throw Error('hq_links_read_failed');links.push(...r.data??[]);if((r.data?.length??0)<500)break;}
 const groups=groupStandardCatalogSkus(rows).sort((a,b)=>a.code.localeCompare(b.code)).map(g=>({...g,spuIds:g.skus.map(s=>Number(links.find(l=>l.sku_id===s.id)?.yz_item_id??0))}));
 validateMeluoCatalog(groups);
 const digest=createHash('sha256').update(JSON.stringify({target:MELUO_SHOP_ID,channel,groups:groups.map(g=>({code:g.code,ids:g.skus.map(s=>s.id),spu:g.spuIds[0]}))})).digest('hex');
 // No mutation or token refresh on dry-run; only sanitized immutable plan data.
 if(mode==='dry-run'){await writeFile(receiptPath,JSON.stringify({mode,digest,target:MELUO_SHOP_ID,channel,groups:14,skus:448,canary:false},null,2));console.log(JSON.stringify({mode,digest,groups:14,skus:448,writes:0}));return;}
 const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
 if(receipt.digest!==digest||receipt.target!==MELUO_SHOP_ID)throw Error('dry_run_stale');
 // Existing code uses is_partial=1, but authoritative append semantics have not been verified here.
 // This gate intentionally has NO environment override: do not perform writes on assumed semantics.
 throw Error('official_partial_channel_append_contract_required');
 // Once the official contract is reviewed, the only allowable writer is buildMeluoChannelAppend.
 // Canary must read back HQ invariant fields + other channels, exact target 32 barcodes,
 // then persist a same-digest receipt before all 14 groups. No stock/image/release API is allowed.
}
void buildMeluoChannelAppend;
main().catch(error=>{const message=error instanceof Error?error.message:'';const safe=/^[a-z0-9_]+$/.test(message)?message:'single_target_blocked';console.error(JSON.stringify({ok:false,error:safe,writes:0}));process.exitCode=1;});