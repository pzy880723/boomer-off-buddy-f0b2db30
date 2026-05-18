import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 是否为首次登录强制修改（不允许关闭） */
  force?: boolean;
  onSuccess?: () => void;
};

export function ChangePasswordDialog({ open, onOpenChange, force, onSuccess }: Props) {
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setPwd("");
      setPwd2("");
    }
  }, [open]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pwd.length < 6) {
      toast.error("密码至少 6 位");
      return;
    }
    if (pwd !== pwd2) {
      toast.error("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({
      password: pwd,
      data: { must_change_password: false },
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("密码已修改");
    onSuccess?.();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (force && !v) return;
        onOpenChange(v);
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={force ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={force ? (e) => e.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            {force ? "首次登录请修改密码" : "修改密码"}
          </DialogTitle>
          <DialogDescription>
            {force
              ? "为了你的账号安全，请先设置一个新密码再继续使用系统。"
              : "请输入新密码，下次登录时生效。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-pwd">新密码</Label>
            <Input
              id="new-pwd"
              type="password"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="至少 6 位"
              autoFocus
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-pwd2">再次输入</Label>
            <Input
              id="new-pwd2"
              type="password"
              value={pwd2}
              onChange={(e) => setPwd2(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            {!force && (
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
            )}
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              确认修改
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
