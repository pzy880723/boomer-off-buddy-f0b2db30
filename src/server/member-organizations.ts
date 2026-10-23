// No credentials, raw responses or member assets leave this bounded read helper.
type Organization = {kdt_id:number;parent_kdt_id:number};
type PageReader = (params:{page_num:number;page_size:number})=>Promise<unknown>;
export async function loadMemberOrganizations(read:PageReader):Promise<Organization[]> {
 const rows:Organization[]=[];
 const seen=new Set<number>();
 let expectedTotal:number|undefined;
 // Exhaustion is blocked, never treated as a complete organization snapshot.
 for(let page_num=1;page_num<=100;page_num++) {
  const payload=await read({page_num,page_size:50});
  if(!payload || typeof payload!=='object')throw Error('organization_schema_unverified');
  const envelope=payload as Record<string,unknown>;
  if(!Array.isArray(envelope.organization_list))throw Error('organization_schema_unverified');
  const total=Number(envelope.total);
  if(!Number.isSafeInteger(total) || total<0 || Number(envelope.page_num)!==page_num || Number(envelope.page_size)!==50)throw Error('organization_pagination_unverified');
  if(expectedTotal!==undefined && expectedTotal!==total)throw Error('organization_total_changed');
  expectedTotal=total;
  const page=envelope.organization_list;
  if(page.length>50)throw Error('organization_page_invalid');
  if(page.length!==Math.min(50,total-rows.length))throw Error('organization_page_incomplete');
  for(const value of page) {
   if(!value || typeof value!=='object')throw Error('organization_schema_unverified');
   const raw=value as Record<string,unknown>;
   const kdt_id=Number(raw.kdt_id),parent_kdt_id=Number(raw.parent_kdt_id);
   if(!Number.isSafeInteger(kdt_id) || kdt_id<=0 || !Number.isSafeInteger(parent_kdt_id) || parent_kdt_id<=0)throw Error('organization_identity_unverified');
   if(seen.has(kdt_id))throw Error('organization_duplicate_or_repeated_page');
   seen.add(kdt_id);rows.push({kdt_id,parent_kdt_id});
  }
  if(rows.length===total)return rows;
 }
 throw Error('organization_pagination_incomplete');
}
export function hasVerifiedBranch(rows:Organization[],kdtId:number,parentKdtId:number):boolean {
 const matches=rows.filter(row=>row.kdt_id===kdtId);
 return matches.length===1 && matches[0]?.parent_kdt_id===parentKdtId;
}