// Official getter is HQ-scoped for chains, not a branch inheritance proof.
export async function inspectHqPointsPolicy(input:unknown,hqKdtId:number,organizationVerified:boolean) {
 const invalid={supported:false,scope:'youzan_chain_hq',fingerprint:''};
 if(!organizationVerified||!Number.isSafeInteger(hqKdtId)||hqKdtId<=0||!input||typeof input!=='object')return invalid;
 const p=input as Record<string,unknown>;
 if(Number(p.kdt_id)!==hqKdtId||!['none','part','all','partNot'].includes(String(p.online_range_type))||typeof p.default_point_deduct!=='boolean'||!Array.isArray(p.online_item_ids)||!Array.isArray(p.content_list))return invalid;
 if(p.online_item_ids.some(id=>!Number.isSafeInteger(id)||Number(id)<0))return invalid;
 const plugins=p.content_list.filter((v):v is Record<string,unknown>=>!!v&&typeof v==='object');
 const five=plugins.filter(v=>v.plugin_id===5),six=plugins.filter(v=>v.plugin_id===6);
 if(five.length!==1||six.length!==1||typeof five[0].policy_value!=='string'||typeof six[0].policy_value!=='string')return invalid;
 const ratio=Number(five[0].policy_value);if(!five[0].policy_value.trim()||!Number.isFinite(ratio)||ratio<=0)return invalid;
 let rule:Record<string,unknown>;
 try {const parsed:unknown=JSON.parse(six[0].policy_value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return invalid;rule=parsed as Record<string,unknown>;}catch{return invalid;}
 if(![0,1].includes(Number(rule.status))||typeof rule.status!=='number'||![0,1].includes(Number(rule.amountType))||typeof rule.amountType!=='number'||![0,1,2].includes(Number(rule.deductType))||typeof rule.deductType!=='number')return invalid;
 for(const k of ['amountLowerLimit','deductUpperLimit'])if(typeof rule[k]!=='number'||!Number.isFinite(rule[k])||Number(rule[k])<0)return invalid;
 const canonical={hqKdtId,scope:'youzan_chain_hq',range:p.online_range_type,items:[...new Set(p.online_item_ids)].sort((a,b)=>Number(a)-Number(b)),defaultDeduct:p.default_point_deduct,plugin5PolicyValue:ratio,rule:{status:rule.status,amountType:rule.amountType,amountLowerLimit:rule.amountLowerLimit,deductType:rule.deductType,deductUpperLimit:rule.deductUpperLimit}};
 // Fingerprint only; no credentials, PII, member balances or invented conversion units.
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical)));
 return {supported:true,scope:'youzan_chain_hq',fingerprint:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
}