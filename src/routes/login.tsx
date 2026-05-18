import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Mail, Lock, Loader2, ShieldCheck, Sparkles, BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuthSession } from "@/hooks/use-auth-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import logo from "@/assets/logo-boomeroff.png";
import logoWhite from "@/assets/logo-boomeroff-white.png";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading } = useAuthSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionLoading && session) {
      navigate({ to: "/dashboard", replace: true });
    }
  }, [session, sessionLoading, navigate]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (err) {
      setError(err.message === "Invalid login credentials" ? "邮箱或密码错误" : err.message);
      return;
    }
    toast.success("登录成功，欢迎回来");
    navigate({ to: "/dashboard", replace: true });
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* 左侧品牌栏 */}
      <aside className="relative hidden flex-1 overflow-hidden bg-gradient-brand p-12 text-primary-foreground md:flex md:flex-col md:justify-between">
        <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-white/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-40 -right-20 h-[28rem] w-[28rem] rounded-full bg-black/20 blur-3xl" />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "radial-gradient(rgba(255,255,255,0.7) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        />

        <div className="relative">
          <img
            src={logoWhite}
            alt="BOOMER OFF"
            className="h-20 w-auto opacity-95"
          />
        </div>

        <div className="relative space-y-6">
          <h1 className="text-4xl font-bold leading-tight tracking-tight">
            中古杂货 ·<br />全链路 ERP 管理
          </h1>
          <p className="max-w-md text-sm leading-relaxed text-primary-foreground/80">
            从日本采购、跨境物流、库存调拨到门店分销，一个后台串起所有环节。
          </p>
          <ul className="space-y-3 pt-4">
            {[
              { icon: Sparkles, text: "AI 智能识别订单截图，秒级入库" },
              { icon: BarChart3, text: "实时利润、库存、物流多维仪表盘" },
              { icon: ShieldCheck, text: "权限受控，账号由管理员统一管理" },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm text-primary-foreground/90">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/15 backdrop-blur">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative text-xs text-primary-foreground/60">
          © {new Date().getFullYear()} BOOMER OFF · All rights reserved.
        </div>
      </aside>

      {/* 右侧表单 */}
      <main className="flex w-full flex-1 items-center justify-center px-6 py-12 md:max-w-[560px]">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 md:hidden">
            <img src={logo} alt="BOOMER OFF" className="h-8 w-8" />
            <span className="text-sm font-semibold">BOOMER OFF</span>
          </div>

          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">欢迎回来</h2>
            <p className="text-sm text-muted-foreground">使用管理员分配的账号登录后台</p>
          </div>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">邮箱</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="h-11 pl-9"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">密码</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="h-11 pl-9"
                />
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <Button
              type="submit"
              disabled={submitting}
              className="h-11 w-full bg-gradient-brand shadow-elegant transition-transform hover:scale-[1.01]"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> 登录中…
                </>
              ) : (
                "登录后台"
              )}
            </Button>

            <p className="pt-2 text-center text-xs text-muted-foreground">
              账号由管理员统一添加，本系统不开放注册
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
