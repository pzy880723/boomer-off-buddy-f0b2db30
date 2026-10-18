import { Ruler, ImageOff } from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import type {MeasurementCard} from '@/lib/measurement-card';
export function MeasurementCardView({card,onRecord}:{card:MeasurementCard;onRecord?:(card:MeasurementCard)=>void}) {
 const active=card.status==='pending'||card.status==='claimed';
 return <div className="mt-3 flex min-w-0 items-start gap-3 border-t pt-3">
  {card.image_url ? <img src={card.image_url} alt={card.product_name} className="h-20 w-20 shrink-0 rounded-md object-contain bg-muted" /> : <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md bg-muted"><ImageOff className="h-5 w-5 text-muted-foreground"/></div>}
  <div className="min-w-0 space-y-2"><p className="break-words text-sm font-medium">{card.product_name}</p><Badge variant="outline">{{pending:'待测量',claimed:'测量中',completed:'已测量',cancelled:'已取消'}[card.status]}</Badge>
   {card.measurement && <p className="text-xs text-muted-foreground">{Object.entries(card.measurement).filter(([,v])=>v!==null).map(([k,v])=>`${({height_cm:'高',width_cm:'宽',depth_cm:'深',diameter_cm:'直径'} as Record<string,string>)[k]} ${v} cm`).join(' · ')}</p>}
   {active && onRecord && <Button size="sm" variant="outline" onClick={()=>onRecord(card)}><Ruler className="mr-2 h-4 w-4"/>填写尺寸</Button>}
  </div>
 </div>;
}
