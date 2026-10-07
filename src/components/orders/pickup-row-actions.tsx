import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { markPickupReady } from "@/lib/pickup.functions";
import { PickupRedeemDialog } from "./pickup-redeem-dialog";

const PREPARING = new Set(["unallocated", "allocated", "picking", "picked", "packing", "packed"]);

/** 自提子单右侧操作：备货完成 / 核销（核销仍需扫码或输入提货码，走同一鉴权服务）。 */
export function PickupRowActions(props: {
  fulfillmentId: string;
  locationId: string | null;
  storeName: string | null;
  status: string;
  blocked?: boolean;
  onChanged?: () => void;
}) {
  const qc = useQueryClient();
  const readyFn = useServerFn(markPickupReady);
  const ready = useMutation({
    mutationFn: () => readyFn({ data: { location_id: props.locationId!, fulfillment_id: props.fulfillmentId, idempotency_key: crypto.randomUUID() } }),
    onSuccess: (r) => {
      (r.ok ? toast.success : toast.error)(r.message);
      void qc.invalidateQueries({ queryKey: ["commerce-orders"] });
      props.onChanged?.();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!props.locationId || props.status === "handed_over" || props.blocked) return null;
  return (
    <div className="flex items-center gap-1.5">
      {PREPARING.has(props.status) && (
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={ready.isPending} onClick={() => ready.mutate()}>
          备货完成
        </Button>
      )}
      <PickupRedeemDialog
        fixedLocation={{ id: props.locationId, name: props.storeName }}
        expectedFulfillmentId={props.fulfillmentId}
        onDone={props.onChanged}
        trigger={<Button size="sm" className="h-7 px-2 text-xs">核销</Button>}
      />
    </div>
  );
}
