import {useServerFn} from '@tanstack/react-start';
import {useInfiniteQuery} from '@tanstack/react-query';
import {ArrowRight} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {getWorkItemsFn} from '@/lib/work-items.functions';
import type {WorkItem} from '@/lib/handheld/work-items';
function target(item:WorkItem) {
 switch(item.action){
 case 'support_conversation':return `/customer-service?conversation_id=${item.target_id}`;
 case 'measurement_task':return '/inventory/measurements';
 case 'fulfillment_detail':return '/orders/online';
 case 'after_sale_detail':return '/orders/after-sales';
 case 'transfer_detail':return '/inventory/transfers';
 case 'stocktake_detail':return `/inventory/stocktakes/${item.target_id}`;
 case 'sync_detail':return '/youzan';
 default:return '/dashboard';
 }
}
export function PendingWorkItems({locationId}:{locationId?:string}) {
 const load=useServerFn(getWorkItemsFn);
 const query=useInfiniteQuery({queryKey:['work-items',locationId],initialPageParam:'',queryFn:({pageParam})=>load({data:{locationId,cursor:pageParam||undefined}}),getNextPageParam:p=>p.next_cursor??undefined,refetchInterval:15000});
 const counts=query.data?.pages[0]?.counts;
 const items=query.data?.pages.flatMap(p=>p.items)??[];
 return <section className="space-y-3" aria-label="全部待处理事项"><div className="flex items-center gap-2"><h2 className="font-semibold">全部待处理事项</h2><Badge variant="secondary" className="tabular-nums">{counts?.total??'—'}</Badge></div>
 {counts && <div className="flex flex-wrap gap-4 text-xs text-muted-foreground"><span>客户 {counts.customers}</span><span>内部 {counts.internal}</span><span>订单 {counts.orders}</span><span>系统 {counts.system}</span></div>}
 {query.isError ? <div className="text-sm text-destructive">待办暂时无法读取<Button variant="ghost" size="sm" onClick={()=>query.refetch()}>重试</Button></div>:query.isLoading?<p className="text-sm text-muted-foreground">加载中…</p>:items.length===0?<p className="text-sm text-muted-foreground">当前没有待处理事项</p>:<div className="divide-y border-y">{items.map(item=><a key={`${item.type}:${item.id}`} href={target(item)} className="flex min-w-0 items-center gap-3 py-3 hover:bg-muted/30">{item.image_url&&<img src={item.image_url} alt="" className="h-12 w-12 shrink-0 rounded-md object-contain"/>}<div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.title}</p><p className="break-words text-xs text-muted-foreground">{item.description}</p></div><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground"/></a>)}</div>}
 {query.hasNextPage && <Button variant="outline" onClick={()=>query.fetchNextPage()} disabled={query.isFetchingNextPage}>加载更多</Button>}
 </section>;
}
