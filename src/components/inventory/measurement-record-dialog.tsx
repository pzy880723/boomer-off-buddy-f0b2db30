import {useRef,useState} from 'react';
import {useServerFn} from '@tanstack/react-start';
import {useMutation,useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogFooter} from '@/components/ui/dialog';
import {MeasurementFields,emptyMeasurementFields,parseMeasurementFields} from './measurement-fields';
import {MeasurementCardView} from './measurement-card-view';
import {saveMeasurement} from '@/lib/measurement.functions';
import type {MeasurementCard} from '@/lib/measurement-card';
export function MeasurementRecordDialog({card,onClose}:{card:MeasurementCard;onClose:()=>void}) {
 const save=useServerFn(saveMeasurement);const qc=useQueryClient();
 const [fields,setFields]=useState({...emptyMeasurementFields});
 // Unknown outcome keeps the exact op + revision + body; edited inputs create a new op.
 const attempt=useRef<{fingerprint:string;op:string}|null>(null);
 const mutation=useMutation({mutationFn:async()=>{
  const parsed=parseMeasurementFields(fields);if(!parsed.ok)throw new Error(parsed.error);
  const fingerprint=JSON.stringify([card.task_id,card.measurement_revision,parsed.value]);
  if(attempt.current?.fingerprint!==fingerprint)attempt.current={fingerprint,op:`erp-measurement:${crypto.randomUUID()}`};
  return save({data:{task_id:card.task_id,expected_revision:card.measurement_revision,client_op_id:attempt.current.op,measurement:parsed.value}});
 },onSuccess:()=>{toast.success('尺寸已保存');void qc.invalidateQueries({queryKey:['measurement-tasks']});void qc.invalidateQueries({queryKey:['support-conversation']});void qc.invalidateQueries({queryKey:['support-conversations']});void qc.invalidateQueries({queryKey:['work-items']});onClose();},onError:(e:Error)=>toast.error(e.message)});
 return <Dialog open onOpenChange={v=>!v&&!mutation.isPending&&onClose()}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>录入实测尺寸</DialogTitle></DialogHeader><MeasurementCardView card={card}/><MeasurementFields state={fields} onChange={setFields}/><DialogFooter><Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>取消</Button><Button onClick={()=>mutation.mutate()} disabled={mutation.isPending}>{mutation.isPending?'保存中…':'保存并通知顾客'}</Button></DialogFooter></DialogContent></Dialog>;
}
