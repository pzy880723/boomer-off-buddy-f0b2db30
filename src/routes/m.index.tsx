import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Package, ScanLine, Boxes, ArrowDownToLine, Camera, Search, Tags, ShoppingBag } from "lucide-react";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { useServerFn } from "@tanstack/react-start";
import { getMobileCounts } from "@/lib/mobile.functions";

export const Route = createFileRoute("/m/")({
  component: MobileHome,
});

function MobileHome() {
  const fetchCounts = useServerFn(getMobileCounts);
  const { data } = useQuery({
    queryKey: ["mobile-counts"],
    queryFn: () => fetchCounts(),
    staleTime: 30_000,
  });
  const tiles = [
    { to: "/m/parcels", icon: Package, label: "包裹搜索", desc: "按单号/订单号/商品名找包裹", color: "bg-blue-500/10 text-blue-600" },
    { to: "/m/skus", icon: Tags, label: "商品 SKU", desc: "查看 / 新建商品档案", color: "bg-rose-500/10 text-rose-600" },
    { to: "/m/scan", icon: ScanLine, label: "通用扫码", desc: "条码 / RFID / 订单号 OCR", color: "bg-emerald-500/10 text-emerald-600" },
    { to: "/inventory/inbound/new", icon: Boxes, label: "新建入库单", desc: "分拣后 RFID 入库", color: "bg-amber-500/10 text-amber-600" },
    { to: "/m/inbound", icon: ArrowDownToLine, label: "RFID 入库", desc: "手持机 / 读写器聚合提交", color: "bg-violet-500/10 text-violet-600" },
    { to: "/m/photo-search", icon: Camera, label: "拍照识图", desc: "找包裹·查均价", color: "bg-pink-500/10 text-pink-600" },
    { to: "/m/domestic/quick-add", icon: ShoppingBag, label: "快速录入小包", desc: "截图/拍照 → AI 识别入库", color: "bg-orange-500/10 text-orange-600" },
  ];
  return (
    <MobileShell title="BOOMER OFF · 仓库" noTabBar={false}>
      <div className="space-y-4 p-4">
        <Link
          to="/m/parcels"
          className="flex h-11 items-center gap-2 rounded-xl border bg-muted/40 px-3 text-sm text-muted-foreground active:bg-muted"
        >
          <Search className="h-4 w-4" />
          搜索包裹、单号、商品名…
        </Link>

        <div className="grid grid-cols-2 gap-3">
          <StatCard label="待签收" value={data?.pendingReceive} accent="text-blue-600" />
        </div>

        <div className="space-y-2">
          <h2 className="px-1 text-xs font-medium text-muted-foreground">业务环节</h2>
          <div className="grid grid-cols-2 gap-3">
            {tiles.map((t) => (
              <Link
                key={t.to}
                to={t.to}
                className="group flex flex-col gap-2 rounded-2xl border bg-card p-4 shadow-sm transition-transform active:scale-[0.98]"
              >
                <span className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${t.color}`}>
                  <t.icon className="h-5 w-5" />
                </span>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold">{t.label}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{t.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </MobileShell>
  );
}

function StatCard({ label, value, accent }: { label: string; value?: number; accent?: string }) {
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accent ?? ""}`}>{value ?? "—"}</div>
    </div>
  );
}
