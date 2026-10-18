import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  claimMeasurementTaskFn,
  listMeasurementTasks,
  saveMeasurement,
} from "@/lib/measurement.functions";
import {
  MeasurementFields,
  emptyMeasurementFields,
  parseMeasurementFields,
  type MeasurementFieldState,
} from "@/components/inventory/measurement-fields";

export const Route = createFileRoute("/inventory/measurements")({
  head: () => ({meta:[{title:"尺寸测量待办 | BOOMER ERP"},{name:"description",content:"授权门店的顾客尺寸申请与测量记录。"},{property:"og:title",content:"尺寸测量待办 | BOOMER ERP"},{property:"og:description",content:"顾客尺寸申请与测量记录。"},{property:"og:type",content:"website"},{name:"twitter:card",content:"summary"}]}),
  component: MeasurementTasksPage,
});

type TaskRow = {
  id: string;
  sku_id: string;
  listing_id: string | null;
  location_id: string | null;
  status: string;
  claimed_by: string | null;
  created_at: string;
  sku_name: string | null;
  location_name: string | null;
  requester_count: number;
  measurement_revision: number;
  stock_available?: boolean;
  image_url?: string|null;
};

const STATUS_TABS = [
  { key: "active", label: "待处理", statuses: ["pending", "claimed"] as const },
  { key: "completed", label: "已完成", statuses: ["completed"] as const },
] as const;

function MeasurementTasksPage() {
  const listFn = useServerFn(listMeasurementTasks);
  const claimFn = useServerFn(claimMeasurementTaskFn);
  const saveFn = useServerFn(saveMeasurement);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]["key"]>("active");
  const [recording, setRecording] = useState<TaskRow | null>(null);
  const [fields, setFields] = useState<MeasurementFieldState>({ ...emptyMeasurementFields });

  const attempt = useRef<{fingerprint:string;op:string}|null>(null);
  const statuses = STATUS_TABS.find((t) => t.key === tab)?.statuses ?? STATUS_TABS[0].statuses;
  const query = useQuery({
    queryKey: ["measurement-tasks", tab],
    queryFn: () => listFn({ data: { statuses: [...statuses] } }),
  });

  const claimMut = useMutation({
    mutationFn: (taskId: string) => claimFn({ data: { task_id: taskId } }),
    onSuccess: () => {
      toast.success("已领取");
      queryClient.invalidateQueries({ queryKey: ["measurement-tasks"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!recording) throw new Error("缺少任务");
      const parsed = parseMeasurementFields(fields);
      if (!parsed.ok) throw new Error(parsed.error);
      const v = parsed.value;
      const fingerprint=JSON.stringify([recording.id,recording.measurement_revision,v]);
      if(attempt.current?.fingerprint!==fingerprint) attempt.current={fingerprint,op:`erp-measurement:${crypto.randomUUID()}`};
      if (v.height_cm == null && v.width_cm == null && v.depth_cm == null && v.diameter_cm == null) {
        throw new Error("至少填写一项尺寸");
      }
      return saveFn({
        data: {
          task_id: recording.id,
          expected_revision: recording.measurement_revision,
          client_op_id: attempt.current.op,
          measurement: v,
        },
      });
    },
    onSuccess: (res) => {
      toast.success(
        res.replayed
          ? "该任务此前已保存（幂等回放）"
          : `已保存实测尺寸${res.notified ? `，已通知 ${res.notified} 位顾客` : ""}`,
      );
      setRecording(null);
      queryClient.invalidateQueries({ queryKey: ["measurement-tasks"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const items = (query.data?.items ?? []) as TaskRow[];

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold">尺寸测量待办</h1>
        <p className="text-xs text-muted-foreground">
          顾客申请测量的商品会出现在这里。录入实测尺寸后，所有申请者会收到通知，尺寸对所有用户可见。
        </p>
      </div>

      <div className="flex gap-2">
        {STATUS_TABS.map((t) => (
          <Button
            key={t.key}
            size="sm"
            variant={tab === t.key ? "default" : "outline"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {query.isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
      {query.isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">待办加载失败</p>
          <p className="text-xs text-muted-foreground">{(query.error as Error).message}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => query.refetch()}>
            重试
          </Button>
        </div>
      )}
      {!query.isLoading && !query.isError && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {tab === "active" ? "当前没有待测量任务" : "暂无已完成记录"}
        </p>
      )}

      <div className="space-y-2">
        {items.map((task) => (
          <div
            key={task.id}
            className="flex items-center justify-between gap-3 rounded-md border px-4 py-3"
          >
            {task.image_url && <img src={task.image_url} alt={task.sku_name ?? "商品"} className="h-16 w-16 shrink-0 rounded-md bg-muted object-contain"/>}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{task.sku_name ?? "未知商品"}</p>
              <p className="text-xs text-muted-foreground">
                {task.location_name ?? "未分配门店"}
                {task.stock_available === false ? "（该店暂无实物，已挂起）" : ""} · {task.requester_count} 人申请 ·{" "}
                {new Date(task.created_at).toLocaleString("zh-CN")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={task.status === "claimed" ? "secondary" : "outline"}>
                {task.status === "claimed" ? "已领取" : task.status === "completed" ? "已完成" : "待领取"}
              </Badge>
              {task.status === "pending" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => claimMut.mutate(task.id)}
                  disabled={claimMut.isPending}
                >
                  领取
                </Button>
              )}
              {task.status !== "completed" && (
                <Button
                  size="sm"
                  onClick={() => {
                    setRecording(task);
                    setFields({ ...emptyMeasurementFields });
                  }}
                >
                  录入尺寸
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={!!recording} onOpenChange={(v) => !v && setRecording(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>录入实测尺寸 · {recording?.sku_name ?? ""}</DialogTitle>
          </DialogHeader>
          {recording?.image_url && <img src={recording.image_url} alt={recording.sku_name ?? "商品"} className="h-28 w-28 rounded-md bg-muted object-contain"/>}
          <MeasurementFields state={fields} onChange={setFields} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRecording(null)}>
              取消
            </Button>
            <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
              {saveMut.isPending ? "保存中…" : "保存并通知顾客"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
