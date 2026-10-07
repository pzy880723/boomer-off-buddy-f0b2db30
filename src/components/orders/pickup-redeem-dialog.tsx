import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ScanLine } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listPickupLocations, redeemPickup, type PickupActionResult } from "@/lib/pickup.functions";
import { parsePickupInput } from "@/lib/commerce/pickup-view";

/** 自提核销：扫码枪输入二维码文本回车即核销，或手输 4 位码。门店必须明确选择。 */
export function PickupRedeemDialog(props: {
  fixedLocation?: { id: string; name: string | null };
  expectedFulfillmentId?: string;
  trigger?: React.ReactNode;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [locationId, setLocationId] = useState(props.fixedLocation?.id ?? "");
  const [value, setValue] = useState("");
  const [last, setLast] = useState<PickupActionResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const locFn = useServerFn(listPickupLocations);
  const redeemFn = useServerFn(redeemPickup);
  const locations = useQuery({ queryKey: ["pickup-locations"], queryFn: () => locFn(), enabled: open && !props.fixedLocation });

  useEffect(() => {
    if (!props.fixedLocation && !locationId && locations.data?.length === 1) setLocationId(locations.data[0].id);
  }, [locations.data, locationId, props.fixedLocation]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50); }, [open, locationId]);

  const mutation = useMutation({
    mutationFn: (input: string) => redeemFn({ data: {
      location_id: locationId, input, idempotency_key: crypto.randomUUID(),
      ...(props.expectedFulfillmentId ? { expected_fulfillment_id: props.expectedFulfillmentId } : {}),
    } }),
    onSuccess: (r) => {
      setLast(r);
      setValue("");
      if (r.result === "redeemed") toast.success(r.message);
      else if (r.ok) toast.message(r.message);
      else toast.error(r.message);
      void qc.invalidateQueries({ queryKey: ["commerce-orders"] });
      props.onDone?.();
      inputRef.current?.focus();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const submit = (raw: string) => {
    if (!locationId || mutation.isPending) return;
    if (!parsePickupInput(raw)) { toast.error("请扫描提货二维码或输入 4 位提货码"); return; }
    mutation.mutate(raw.trim());
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setLast(null); setValue(""); } }}>
      <DialogTrigger asChild>
        {props.trigger ?? <Button size="sm"><ScanLine className="mr-1.5 h-3.5 w-3.5" /> 自提核销</Button>}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>门店自提核销</DialogTitle>
          <DialogDescription>扫码枪扫描顾客的提货二维码会自动核销；也可输入 4 位提货码后回车。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>核销门店</Label>
            {props.fixedLocation ? (
              <div className="rounded-md border px-3 py-2 text-sm">{props.fixedLocation.name ?? "当前门店"}</div>
            ) : (
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger><SelectValue placeholder={locations.isLoading ? "加载中…" : "选择门店"} /></SelectTrigger>
                <SelectContent>
                  {(locations.data ?? []).map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {!props.fixedLocation && locations.data?.length === 0 && (
              <p className="text-xs text-destructive">你没有任何门店的核销权限。</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pickup-input">提货二维码 / 4 位提货码</Label>
            <Input
              id="pickup-input" ref={inputRef} autoComplete="off" disabled={!locationId}
              value={value}
              onChange={(e) => {
                const v = e.target.value;
                setValue(v);
                if (/^BOOMER_PICKUP:[0-9a-f]{64}$/.test(v.trim())) submit(v);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(value); } }}
              placeholder={locationId ? "扫描或输入后回车" : "请先选择门店"}
              className="font-mono text-lg tracking-widest"
            />
          </div>
          {last && (
            <p role="status" className={last.result === "redeemed" ? "text-sm font-medium text-primary" : last.ok ? "text-sm" : "text-sm text-destructive"}>
              {last.message}{last.replayed ? "（重复提交，未重复处理）" : ""}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>关闭</Button>
          <Button disabled={!locationId || !value.trim() || mutation.isPending} onClick={() => submit(value)}>核销</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
