import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import {
  Phone,
  Lock,
  Loader2,
  ShieldCheck,
  Sparkles,
  BarChart3,
  Eye,
  EyeOff,
  AlertCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuthSession } from "@/hooks/use-auth-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PHONE_REGEX, phoneToEmail } from "@/lib/auth-config";
import logo from "@/assets/logo-boomeroff.png";
import logoWhite from "@/assets/logo-boomeroff-white.png";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const { session, loading: sessionLoading } = useAuthSession();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!sessionLoading && session) {
      setRedirecting(true);
      router.invalidate();
      navigate({ to: "/dashboard", replace: true });
    }
  }, [session, sessionLoading, navigate, router]);

  const inputsDisabled = submitting || redirecting;

  async function doSubmit() {
    if (submitting || redirecting) return;
    setError(null);

    const cleanPhone = phone.trim();
    if (!PHONE_REGEX.test(cleanPhone)) {
      setError("手机号格式不正确，请输入 11 位中国大陆手机号");
      return;
    }
    if (!password) {
      setError("请输入密码");
      return;
    }

    setSubmitting(true);
    try {
      const { error: err } = await supabase.auth.signInWithPassword({
        email: phoneToEmail(cleanPhone),
        password,
      });

      if (err) {
        setSubmitting(false);
        setError("手机号或密码错误，请重新输入或联系管理员");
        return;
      }
      // 登录成功后由 useEffect 监听 session 跳转
      setRedirecting(true);
    } catch (err) {
      setSubmitting(false);
      setError("登录请求失败，请稍后重试");
      console.error("[login] signIn threw", err);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void doSubmit();
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
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
          <img src={logoWhite} alt="BOOMER OFF" className="h-14 w-auto opacity-95" />
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
              <li key={text} className="flex items-center gap-3 text-sm text-primary-foreground/90">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/15 backdrop-blur">
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

      <main className="relative flex w-full flex-1 items-center justify-center px-6 py-12 md:max-w-[560px]">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 md:hidden">
            <img src={logo} alt="BOOMER OFF" className="h-8 w-8" />
            <span className="text-sm font-semibold">BOOMER OFF</span>
          </div>

          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">欢迎回来</h2>
            <p className="text-sm text-muted-foreground">使用管理员分配的手机号登录后台</p>
          </div>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="phone">手机号</Label>
              <div className="relative">
                <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel"
                  required
                  maxLength={11}
                  disabled={inputsDisabled}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                  placeholder="13800138000"
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
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  disabled={inputsDisabled}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="h-11 pl-9 pr-10"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={inputsDisabled}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <Alert className="border-destructive/30 bg-destructive/5 text-destructive [&>svg]:text-destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>登录失败</AlertTitle>
                <AlertDescription className="mt-1 text-xs opacity-90">{error}</AlertDescription>
              </Alert>
            )}

            <Button
              type="submit"
              disabled={inputsDisabled}
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

        {redirecting && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/85 backdrop-blur-sm">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">正在进入后台…</p>
          </div>
        )}
      </main>
    </div>
  );
}
