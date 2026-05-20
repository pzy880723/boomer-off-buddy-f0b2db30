import { createFileRoute, Link } from "@tanstack/react-router";
import { Boxes, ScanLine, PackageCheck } from "lucide-react";
import { MobileShell } from "@/components/mobile/mobile-shell";

export const Route = createFileRoute("/store/")({
  component: StoreHome,
});

function StoreHome() {
  const tiles = [
    { to: "/store/inventory", icon: Boxes, label: "本店库存", desc: "按品名 / 类目搜索" },
    { to: "/store/scan", icon: ScanLine, label: "扫码溯源", desc: "扫 RFID 看均价" },
    { to: "/store/incoming", icon: PackageCheck, label: "待收货", desc: "调拨到本店的批次" },
  ];
  return (
    <MobileShell title="BOOMER OFF · 门店" base="/store">
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3">
          {tiles.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              className="flex flex-col gap-2 rounded-2xl border bg-card p-4 shadow-sm active:scale-[0.98]"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <t.icon className="h-5 w-5" />
              </span>
              <div>
                <div className="text-sm font-semibold">{t.label}</div>
                <div className="text-[11px] text-muted-foreground">{t.desc}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </MobileShell>
  );
}
