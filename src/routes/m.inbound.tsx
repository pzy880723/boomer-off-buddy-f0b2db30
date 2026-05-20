import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { MobileShell } from "@/components/mobile/mobile-shell";

export const Route = createFileRoute("/m/inbound")({
  component: () => (
    <MobileShell title="扫码入库" back>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-muted-foreground">
          手机端入库正在与桌面 RPC 复用对接中，当前请在桌面端打开：
        </p>
        <Link
          to="/inventory/inbound/new"
          className="flex h-12 items-center justify-center gap-1 rounded-xl border bg-card font-medium active:bg-muted"
        >
          打开桌面扫码入库 <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </MobileShell>
  ),
});
