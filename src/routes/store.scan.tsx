import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { traceByEpc } from "@/lib/mobile.functions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/store/scan")({
  component: () => {
    const [epc, setEpc] = useState("");
    const fn = useServerFn(traceByEpc);
    const ref = useRef<HTMLInputElement>(null);
    const mut = useMutation({
      mutationFn: (v: string) => fn({ data: { epc: v } }),
      onError: (e) => toast.error((e as Error).message),
    });
    return (
      <MobileShell title="扫码溯源" back="/store" base="/store">
        <form
          className="space-y-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (epc.trim()) mut.mutate(epc.trim());
          }}
        >
          <Input
            ref={ref}
            value={epc}
            onChange={(e) => setEpc(e.target.value)}
            placeholder="扫 RFID 或输入 EPC"
            autoFocus
          />
          <Button type="submit" className="w-full h-11" disabled={mut.isPending}>
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "查询"}
          </Button>
        </form>
        {mut.data?.sku ? (
          <div className="space-y-2 p-3">
            <div className="rounded-2xl border bg-card p-3">
              <div className="text-sm font-medium">{mut.data.sku.name}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                EPC {mut.data.sku.epc} · ¥{Number(mut.data.sku.price_tier).toFixed(1)} · 库存 {mut.data.sku.stock_qty}
              </div>
            </div>
            <div className="rounded-2xl border bg-card p-3 text-[11px]">
              <div className="font-medium mb-1">最近入库</div>
              {(mut.data.lines ?? []).slice(0, 5).map((l) => (
                <div key={l.id} className="flex justify-between py-0.5 text-muted-foreground">
                  <span>{new Date(l.created_at).toLocaleDateString()}</span>
                  <span>×{l.qty} · 单价 ¥{Number(l.unit_price).toFixed(2)}</span>
                </div>
              ))}
              {(mut.data.lines ?? []).length === 0 ? (
                <div className="text-muted-foreground">暂无入库记录</div>
              ) : null}
            </div>
          </div>
        ) : mut.isSuccess ? (
          <div className="px-6 py-6 text-center text-sm text-muted-foreground">未找到对应 EPC</div>
        ) : null}
      </MobileShell>
    );
  },
});
