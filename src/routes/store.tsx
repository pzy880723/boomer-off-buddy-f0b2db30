import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { MobileShell } from "@/components/mobile/mobile-shell";

export const Route = createFileRoute("/store")({
  head: () => ({
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#0F172A" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "BO 门店" },
      { title: "BOOMER OFF · 门店工作台" },
    ],
    links: [
      { rel: "manifest", href: "/store-manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/m-icon-512.png" },
    ],
  }),
  component: () => <Outlet />,
});

export function StorePlaceholder({ title, hint }: { title: string; hint: string }) {
  return (
    <MobileShell title={title} base="/store">
      <div className="space-y-3 p-6 text-center text-sm text-muted-foreground">
        <p>{hint}</p>
        <Link to="/store" className="inline-block rounded border px-3 py-2 text-xs">返回首页</Link>
      </div>
    </MobileShell>
  );
}
