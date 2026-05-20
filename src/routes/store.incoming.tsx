import { createFileRoute } from "@tanstack/react-router";
import { MobileShell } from "@/components/mobile/mobile-shell";

export const Route = createFileRoute("/store/incoming")({
  component: () => (
    <MobileShell title="待收货" back="/store" base="/store">
      <div className="space-y-2 p-6 text-center text-sm text-muted-foreground">
        <p>调拨功能将在 V2 上线。</p>
        <p className="text-xs">届时本店待收货批次会自动出现在这里。</p>
      </div>
    </MobileShell>
  ),
});
