import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, Home, ScanLine, Package, Boxes, Camera } from "lucide-react";
import type { ReactNode } from "react";

export function MobileShell({
  title,
  children,
  back,
  rightSlot,
  noTabBar,
  base = "/m",
}: {
  title: string;
  children: ReactNode;
  back?: boolean | string;
  rightSlot?: ReactNode;
  noTabBar?: boolean;
  base?: "/m" | "/store";
}) {
  const router = useRouter();
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b bg-card/95 px-3 backdrop-blur">
        {back ? (
          <button
            type="button"
            onClick={() => (typeof back === "string" ? router.navigate({ to: back }) : router.history.back())}
            className="-ml-2 inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground active:bg-muted"
            aria-label="返回"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        ) : null}
        <h1 className="truncate text-base font-semibold">{title}</h1>
        <div className="ml-auto flex items-center gap-1">{rightSlot}</div>
      </header>
      <main className="flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+72px)]">
        {children}
      </main>
      {!noTabBar ? <TabBar base={base} /> : null}
    </div>
  );
}

function TabBar({ base }: { base: "/m" | "/store" }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const tabs =
    base === "/m"
      ? [
          { to: "/m", label: "首页", icon: Home, exact: true },
          { to: "/m/parcels", label: "包裹", icon: Package },
          { to: "/m/scan", label: "扫码", icon: ScanLine, primary: true },
          { to: "/m/sort", label: "分拣", icon: Boxes },
          { to: "/m/photo-search", label: "识图", icon: Camera },
        ]
      : [
          { to: "/store", label: "首页", icon: Home, exact: true },
          { to: "/store/inventory", label: "库存", icon: Boxes },
          { to: "/store/scan", label: "扫码", icon: ScanLine, primary: true },
          { to: "/store/incoming", label: "收货", icon: Package },
        ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div className="mx-auto flex max-w-[640px] items-stretch justify-around">
        {tabs.map((t) => {
          const active = t.exact ? path === t.to : path.startsWith(t.to);
          const Icon = t.icon;
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] transition-colors ${
                active ? "text-primary" : "text-muted-foreground"
              }`}
            >
              <span
                className={`inline-flex h-9 w-9 items-center justify-center rounded-full ${
                  t.primary && !active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : active
                      ? "bg-primary/10"
                      : ""
                }`}
              >
                <Icon className="h-5 w-5" />
              </span>
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
