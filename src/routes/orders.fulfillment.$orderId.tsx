import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  getOrderStoreSubOrders,
  manualShipStoreSubOrder,
  reportStoreShortage,
  type StoreSubOrder,
  type StoreSubOrderItem,
} from "@/lib/fulfillment-shortage.functions";

export const Route = createFileRoute("/orders/fulfillment/$orderId")({
  head: () => ({
    meta: [
      { title: "门店子单发货与缺货申报 · BOOMER OFF" },
      { name: "description", content: "按门店查看网店订单子单，录入快递公司与单号发货，或申报缺货。" },
      { property: "og:title", content: "门店子单发货与缺货申报 · BOOMER OFF" },
      { property: "og:description", content: "按门店发货、录入快递单号并申报缺货。" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FulfillmentDetailPage,
});

function newOpId() {
  return crypto.randomUUID();
}

function FulfillmentDetailPage() {
  const { orderId } = Route.useParams();
  const fetchShops = useServerFn(getOrderStoreSubOrders);
  const { data, isLoading } = useQuery({
    queryKey: ["order-store-sub-orders", orderId],
    queryFn: () => fetchShops({ data: { orderId } }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="门店子单履约"
        description={`订单 ${data?.order_no ?? ""}：按门店发货或申报缺货`}
      />
      {isLoading ? <p className="text-muted-foreground text-sm">加载中…</p> : null}
      {(data?.shops ?? []).map((shop) => (
        <ShopCard key={shop.fulfillment_id} shop={shop} orderId={orderId} />
      ))}
      {!isLoading && (data?.shops ?? []).length === 0 ? (
        <p className="text-muted-foreground text-sm">该订单暂无门店子单。</p>
      ) : null}
    </div>
  );
}

function ShopCard({ shop, orderId }: { shop: StoreSubOrder; orderId: string }) {
  const queryClient = useQueryClient();
  const ship = useServerFn(manualShipStoreSubOrder);
  const report = useServerFn(reportStoreShortage);
  const [provider, setProvider] = useState("");
  const [trackingNo, setTrackingNo] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [shortageFor, setShortageFor] = useState<StoreSubOrderItem | null>(null);
  const [shortageQty, setShortageQty] = useState("1");
  const [reason, setReason] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["order-store-sub-orders", orderId] });

  const shipMutation = useMutation({
    mutationFn: async () => {
      const lines = shop.items
        .map((item) => ({
          fulfillmentItemId: item.fulfillment_item_id,
          quantity: Number(quantities[item.fulfillment_item_id] ?? 0),
        }))
        .filter((line) => Number.isInteger(line.quantity) && line.quantity > 0);
      if (lines.length === 0) throw new Error("请填写本次发货数量");
      return ship({
        data: { fulfillmentId: shop.fulfillment_id, provider, trackingNo, clientOpId: newOpId(), lines },
      });
    },
    onSuccess: async () => {
      toast.success("已登记发货");
      setProvider("");
      setTrackingNo("");
      setQuantities({});
      await invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const shortageMutation = useMutation({
    mutationFn: async () => {
      if (!shortageFor) throw new Error("请选择缺货商品");
      return report({
        data: {
          fulfillmentId: shop.fulfillment_id,
          fulfillmentItemId: shortageFor.fulfillment_item_id,
          quantity: Number(shortageQty),
          reason,
          clientOpId: newOpId(),
        },
      });
    },
    onSuccess: async () => {
      toast.success("已申报缺货，已通知客户确认退款");
      setShortageFor(null);
      setReason("");
      setShortageQty("1");
      await invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          {shop.store_name ?? "未命名门店"} · {shop.code}
        </CardTitle>
        <Badge variant="secondary">{shop.status}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          {shop.items.map((item) => (
            <div
              key={item.fulfillment_item_id}
              className="flex flex-wrap items-center gap-3 rounded-md border p-3"
            >
              <span className="flex-1 text-sm">{item.title}</span>
              <span className="text-muted-foreground text-xs">
                应发 {item.expected_qty} · 已发 {item.picked_qty} · 缺货 {item.declared_shortage_qty}
              </span>
              <Input
                className="w-24"
                inputMode="numeric"
                placeholder="本次发货"
                value={quantities[item.fulfillment_item_id] ?? ""}
                onChange={(event) =>
                  setQuantities((prev) => ({ ...prev, [item.fulfillment_item_id]: event.target.value }))
                }
              />
              <Button
                variant="outline"
                size="sm"
                disabled={item.declarable_qty <= 0}
                onClick={() => {
                  setShortageFor(item);
                  setShortageQty(String(Math.min(1, item.declarable_qty) || 1));
                }}
              >
                申报缺货
              </Button>
            </div>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor={`provider-${shop.fulfillment_id}`}>快递公司</Label>
            <Input
              id={`provider-${shop.fulfillment_id}`}
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              placeholder="顺丰 / 中通 …"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`tracking-${shop.fulfillment_id}`}>快递单号</Label>
            <Input
              id={`tracking-${shop.fulfillment_id}`}
              value={trackingNo}
              onChange={(event) => setTrackingNo(event.target.value)}
              placeholder="手工录入，不依赖电子面单"
            />
          </div>
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={!provider || trackingNo.length < 4 || shipMutation.isPending}
              onClick={() => shipMutation.mutate()}
            >
              登记发货
            </Button>
          </div>
        </div>

        {shortageFor ? (
          <div className="space-y-3 rounded-md border border-dashed p-3">
            <p className="text-sm font-medium">
              申报缺货：{shortageFor.title}（最多 {shortageFor.declarable_qty} 件）
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor={`qty-${shop.fulfillment_id}`}>缺货数量</Label>
                <Input
                  id={`qty-${shop.fulfillment_id}`}
                  inputMode="numeric"
                  value={shortageQty}
                  onChange={(event) => setShortageQty(event.target.value)}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor={`reason-${shop.fulfillment_id}`}>缺货原因</Label>
                <Textarea
                  id={`reason-${shop.fulfillment_id}`}
                  rows={2}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="例如：货架实物已售出"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                disabled={!reason || shortageMutation.isPending}
                onClick={() => shortageMutation.mutate()}
              >
                提交申报
              </Button>
              <Button variant="ghost" onClick={() => setShortageFor(null)}>
                取消
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
