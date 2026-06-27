import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  Package,
  Boxes,
  Store,
  BookOpen,
  Settings,
  Plane,
  Mail,
  ShoppingBag,
  PackageCheck,
  ClipboardList,
  Truck,
  Receipt,
  Tags,
  Layers,
  ArrowLeftRight,
  Building2,
  Users,
  Link2,
  Activity,
  ShieldCheck,
  AlertCircle,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import { useAuthSession } from "@/hooks/use-auth-session";
import { isSuperAdminPhone, resolveUserPhone } from "@/lib/auth-config";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import logoWide from "@/assets/logo-boomeroff-wide.png";

type NavTo =
  | "/dashboard"
  | "/purchase/japan-bulk"
  | "/purchase/japan-parcel"
  | "/purchase/domestic"
  | "/purchase/domestic-bulk"
  | "/inventory/skus"
  | "/inventory/inbound"
  | "/inventory/inbound/new"
  | "/inventory/transfers"
  | "/inventory/locations"
  | "/inventory/devices"
  | "/inventory/unclaimed"
  | "/inventory/stocktakes"
  | "/shop-mgmt/shops"
  | "/shop-mgmt/products"
  | "/shop-mgmt/franchisees"
  | "/youzan"
  | "/youzan/sync"

  | "/orders/shops"
  | "/orders/dispatch"
  | "/orders/wholesale"
  | "/knowledge"
  | "/settings"
  | "/admin/users";

const groups: { label: string; items: { title: string; url: NavTo; icon: LucideIcon }[]; icon?: LucideIcon }[] = [
  {
    label: "总览",
    items: [{ title: "仪表盘", url: "/dashboard", icon: LayoutDashboard }],
  },
  {
    label: "采购物流",
    items: [
      { title: "日本大宗", url: "/purchase/japan-bulk", icon: Plane },
      { title: "日本小包", url: "/purchase/japan-parcel", icon: Mail },
      { title: "国内大宗", url: "/purchase/domestic-bulk", icon: PackageCheck },
      { title: "国内小包", url: "/purchase/domestic", icon: ShoppingBag },
    ],
    icon: Package,
  },
  {
    label: "仓库管理",
    items: [
      { title: "仓库商品", url: "/inventory/skus", icon: Tags },
      { title: "入库记录", url: "/inventory/inbound", icon: Layers },
      { title: "调拨单", url: "/inventory/transfers", icon: ArrowLeftRight },
      { title: "盘点单", url: "/inventory/stocktakes", icon: ClipboardList },
      { title: "待认领 EPC", url: "/inventory/unclaimed", icon: AlertCircle },
      { title: "库位管理", url: "/inventory/locations", icon: Building2 },
      { title: "手持终端", url: "/inventory/devices", icon: Smartphone },
    ],
    icon: Boxes,
  },
  {
    label: "订单管理",
    items: [
      { title: "门店订单", url: "/orders/shops", icon: Receipt },
      { title: "铺货订单", url: "/orders/dispatch", icon: Truck },
      { title: "批发订单", url: "/orders/wholesale", icon: PackageCheck },
    ],
    icon: ClipboardList,
  },
  {
    label: "门店管理",
    items: [
      { title: "门店列表", url: "/shop-mgmt/shops", icon: Building2 },
      { title: "门店商品库", url: "/shop-mgmt/products", icon: Package },
      { title: "加盟商管理", url: "/shop-mgmt/franchisees", icon: Users },
      { title: "有赞门店", url: "/youzan", icon: Link2 },

    ],
    icon: Store,
  },
  {
    label: "运营",
    items: [
      { title: "知识库", url: "/knowledge", icon: BookOpen },
      { title: "系统设置", url: "/settings", icon: Settings },
    ],
  },
];

export function AppSidebar() {
  const router = useRouter();
  const currentPath = useRouterState({ select: (s) => s.location.pathname });
  const { state } = useSidebar();
  const { session } = useAuthSession();
  const isSuperAdmin = isSuperAdminPhone(resolveUserPhone(session?.user));
  const collapsed = state === "collapsed";
  const isActive = (path: string) => currentPath === path || currentPath.startsWith(path + "/");
  const preload = (to: NavTo) => void router.preloadRoute({ to });

  const allGroups = isSuperAdmin
    ? [
        ...groups,
        {
          label: "系统",
          items: [{ title: "账号管理", url: "/admin/users" as NavTo, icon: ShieldCheck }],
        },
      ]
    : groups;

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="border-b border-sidebar-border">
        <Link
          to="/dashboard"
          preload="intent"
          onPointerDown={() => preload("/dashboard")}
          className="flex items-center px-1 py-2"
        >
          {collapsed ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm">
              <span className="text-lg font-black text-[#d32f2f] leading-none">B</span>
            </div>
          ) : (
            <img
              src={logoWide}
              alt="BOOMER OFF — vintage group"
              className="h-10 w-auto max-w-full object-contain"
            />
          )}
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-1">
        {allGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/45">
              {group.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active = isActive(item.url);
                  return (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={item.title}
                        className="relative h-9 data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium hover:bg-sidebar-accent/50"
                      >
                        <Link
                          to={item.url}
                          preload="intent"
                          onMouseEnter={() => preload(item.url)}
                          onPointerDown={() => preload(item.url)}
                          className="flex items-center gap-2.5"
                        >
                          {active && (
                            <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary" />
                          )}
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      {!collapsed && (
        <SidebarFooter className="border-t border-sidebar-border">
          <div className="rounded-lg bg-sidebar-accent/40 p-3">
            <div className="flex items-center gap-2 text-xs text-sidebar-foreground/80">
              <Activity className="h-3.5 w-3.5 text-success" />
              <span className="font-medium">系统状态</span>
            </div>
            <div className="mt-2 space-y-1 text-[11px] text-sidebar-foreground/60">
              <div className="flex items-center justify-between">
                <span>在线门店</span>
                <span className="font-medium tabular-nums text-sidebar-foreground">12 / 14</span>
              </div>
              <div className="flex items-center justify-between">
                <span>有赞同步</span>
                <span className="inline-flex items-center gap-1 text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
                  正常
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>版本</span>
                <span className="tabular-nums">v0.8.4</span>
              </div>
            </div>
          </div>
        </SidebarFooter>
      )}
    </Sidebar>
  );
}
