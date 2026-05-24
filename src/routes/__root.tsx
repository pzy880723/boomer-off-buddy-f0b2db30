import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Search, Bell, CheckCircle2, Command, Loader2, Key, Users } from "lucide-react";
import { useAuthSession } from "@/hooks/use-auth-session";
import { supabase } from "@/integrations/supabase/client";
import { isSuperAdminPhone, resolveUserPhone } from "@/lib/auth-config";
import { ChangePasswordDialog } from "@/components/change-password-dialog";

import appCss from "../styles.css?url";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold">页面未找到</h2>
        <p className="mt-2 text-sm text-muted-foreground">您访问的页面不存在或已被移动。</p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          返回首页
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">页面加载失败</h1>
        <p className="mt-2 text-sm text-muted-foreground">出现了错误，请重试或返回首页。</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button
            onClick={() => {
              router.invalidate();
              reset();
            }}
          >
            重试
          </Button>
          <Button variant="outline" asChild>
            <Link to="/dashboard" preload="intent">返回首页</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "BOOMER OFF · 品牌管理后台" },
      { name: "description", content: "中古杂货品牌的全链路 ERP 管理系统" },
      { property: "og:title", content: "BOOMER OFF · 品牌管理后台" },
      { name: "twitter:title", content: "BOOMER OFF · 品牌管理后台" },
      { property: "og:description", content: "中古杂货品牌的全链路 ERP 管理系统" },
      { name: "twitter:description", content: "中古杂货品牌的全链路 ERP 管理系统" },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/20b76984-169b-41b2-9cc8-899b97c3917e/id-preview-e9d47cb9--2158bffa-7f82-4bc6-9df9-c59319d262f7.lovable.app-1778911275898.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/20b76984-169b-41b2-9cc8-899b97c3917e/id-preview-e9d47cb9--2158bffa-7f82-4bc6-9df9-c59319d262f7.lovable.app-1778911275898.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

const breadcrumbMap: Record<string, string> = {
  dashboard: "仪表盘",
  purchase: "采购物流",
  "japan-bulk": "日本大宗",
  "japan-parcel": "日本小包",
  domestic: "国内小包",
  "domestic-bulk": "国内大宗",
  inventory: "商品库存",
  skus: "商品 SKU",
  products: "商品档案",
  batches: "采购批次",
  transfers: "库存调拨",
  inbound: "扫枪入库",
  new: "新建",
  import: "导入",
  accounts: "账号管理",
  stores: "门店加盟",
  list: "门店列表",
  franchisees: "加盟商管理",
  youzan: "有赞对接",
  knowledge: "知识库",
  settings: "系统设置",
  admin: "管理",
  users: "用户",
  orders: "订单",
  dispatch: "发货",
  shops: "店铺",
  wholesale: "批发",
  "shop-mgmt": "店铺管理",
};

// 看起来像 UUID / 长随机 ID 的段，显示成「详情」而不是裸编码
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isIdLike(seg: string) {
  if (UUID_RE.test(seg)) return true;
  // 纯数字 ID
  if (/^\d{4,}$/.test(seg)) return true;
  // 长随机 token（同时含字母和数字、长度 >= 12）
  if (seg.length >= 12 && /[A-Za-z]/.test(seg) && /\d/.test(seg)) return true;
  return false;
}

function Breadcrumbs() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return <span className="text-sm text-muted-foreground">首页</span>;
  return (
    <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Link to="/dashboard" preload="intent" className="transition-colors hover:text-foreground">
        首页
      </Link>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const href = "/" + segments.slice(0, i + 1).join("/");
        const label = breadcrumbMap[seg] ?? (isIdLike(seg) ? "详情" : seg);
        return (
          <span key={i} className="flex items-center gap-1.5">
            <span className="text-border">/</span>
            {isLast ? (
              <span className="font-medium text-foreground">{label}</span>
            ) : (
              <Link
                to={href as string}
                preload="intent"
                className="transition-colors hover:text-foreground"
              >
                {label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { session, loading } = useAuthSession();
  const isLoginRoute = pathname === "/login";

  useEffect(() => {
    if (!loading && !session && !isLoginRoute) {
      router.navigate({ to: "/login", replace: true });
    }
  }, [loading, session, isLoginRoute, router]);

  if (isLoginRoute) return <>{children}</>;
  if (loading || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <>{children}</>;
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isMobileShell = pathname === "/login" || pathname.startsWith("/m") || pathname.startsWith("/store");

  // 登录页 + 手机端 PWA：不渲染侧栏/顶栏外壳
  if (isMobileShell) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <Outlet />
        </AuthGate>
        <Toaster />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
      <SidebarProvider>
        <div className="flex min-h-screen w-full bg-background">
          <AppSidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-card/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/60">
              <SidebarTrigger className="-ml-1" />
              <div className="hidden h-5 w-px bg-border md:block" />
              <Breadcrumbs />
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  className="hidden h-9 w-72 items-center gap-2 rounded-md border bg-background/60 px-3 text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground md:inline-flex"
                >
                  <Search className="h-4 w-4" />
                  <span className="flex-1 text-left">搜索商品、订单、批次…</span>
                  <kbd className="inline-flex h-5 items-center gap-0.5 rounded border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                    <Command className="h-2.5 w-2.5" />K
                  </kbd>
                </button>
                <div className="hidden items-center gap-1.5 rounded-md border border-success/20 bg-success/10 px-2 py-1 text-xs text-success lg:flex">
                  <CheckCircle2 className="h-3 w-3" />
                  数据已同步 · 2 分钟前
                </div>
                <Button variant="ghost" size="icon" className="relative h-9 w-9">
                  <Bell className="h-4 w-4" />
                  <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                    5
                  </span>
                </Button>
                <UserMenu />
              </div>
            </header>
            <main className="flex-1 overflow-auto">
              <div className="mx-auto w-full max-w-[1480px] p-6">
                <Outlet />
              </div>
            </main>
          </div>
        </div>
        <Toaster />
      </SidebarProvider>
      </AuthGate>
    </QueryClientProvider>
  );
}

function UserMenu() {
  const router = useRouter();
  const { session } = useAuthSession();
  const phone = resolveUserPhone(session?.user) ?? "";
  const email = session?.user?.email ?? "";
  const displayName = phone || email || "管理员";
  const initial = phone ? phone.slice(-1) : email ? email[0]!.toUpperCase() : "管";
  const isAdmin = isSuperAdminPhone(phone);
  const [pwdOpen, setPwdOpen] = useState(false);
  const mustChange = !!session?.user?.user_metadata?.must_change_password;

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/login", replace: true });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-muted">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-gradient-brand text-xs font-medium text-primary-foreground">
              {initial}
            </AvatarFallback>
          </Avatar>
          <div className="hidden text-left lg:block">
            <div className="max-w-[160px] truncate text-xs font-medium leading-tight">
              {displayName}
            </div>
            <div className="text-[10px] leading-tight text-muted-foreground">
              {isAdmin ? "超级管理员" : "已登录"}
            </div>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate">{displayName}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isAdmin && (
          <DropdownMenuItem asChild>
            <Link to="/admin/users" className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              账号管理
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => setPwdOpen(true)} className="gap-2">
          <Key className="h-4 w-4" />
          修改密码
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onClick={handleSignOut}>
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
      <ChangePasswordDialog
        open={pwdOpen || mustChange}
        onOpenChange={setPwdOpen}
        force={mustChange}
      />
    </DropdownMenu>
  );
}

