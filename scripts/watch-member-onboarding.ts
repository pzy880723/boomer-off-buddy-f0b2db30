// Tencent host event consumer: enqueue NOTIFY wakes; startup scans only pending/expired jobs.
import postgres from 'postgres';
import {spawn} from 'node:child_process';
async function main(){
 if(process.env.BOOMER_RUNTIME!=='tencent'||process.env.MEMBER_ONBOARDING_ENABLED!=='true')throw Error('worker_disabled');
 const sql=postgres({max:2});
 const pending=new Set<string>();let running=false;
 async function drain(){
  if(running)return;running=true;
  try{while(pending.size){const id=pending.values().next().value;if(!id)break;pending.delete(id);
   await new Promise<void>((resolve,reject)=>{const child=spawn('bun',['scripts/run-member-onboarding.ts',id],{cwd:process.cwd(),stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('worker_failed')));});
  }}finally{running=false;}
 }
 await sql.listen('member_onboarding',payload=>{if(/^[0-9a-f-]{36}$/i.test(payload)){pending.add(payload);void drain().catch(()=>process.exit(1));}});
 const jobs=await sql<{shop_id:string}[]>`SELECT shop_id FROM public.member_onboarding_jobs WHERE status='queued' OR (status='running' AND lease_until<now()) ORDER BY created_at`;
 jobs.forEach(j=>pending.add(j.shop_id));await drain();
 // Arm one recovery wake only while a lost lease exists, then drain; no permanent database polling.
 async function armLostLease(){
   const leases=await sql<{next_at:Date|null}[]>`SELECT min(lease_until) next_at FROM public.member_onboarding_jobs WHERE status='running'`;
   const at=leases[0]?.next_at;if(!at)return;
   setTimeout(()=>{void (async()=>{const expired=await sql<{shop_id:string}[]>`SELECT shop_id FROM public.member_onboarding_jobs WHERE status='running' AND lease_until<now()`;expired.forEach(j=>pending.add(j.shop_id));await drain();await armLostLease();})().catch(()=>process.exit(1));},Math.max(1000,new Date(at).getTime()-Date.now()+1000));
 }
 await armLostLease();
}
main().catch(()=>{console.error('member_onboarding_watcher_failed');process.exitCode=1;});