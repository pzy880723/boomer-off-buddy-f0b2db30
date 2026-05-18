import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, RotateCcw, Trash2, UserPlus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuthSession } from "@/hooks/use-auth-session";
import { isSuperAdminPhone, PHONE_REGEX, SUPER_ADMIN_PHONES, resolveUserPhone } from "@/lib/auth-config";
import {
  listUsersFn,
  createUserFn,
  resetUserPasswordFn,
  deleteUserFn,
  updateUserNameFn,
} from "@/lib/admin-users.functions";

export const Route = createFileRoute("/admin/users")({
  head: () => ({ meta: [{ title: "账号管理 · BOOMER OFF" }] }),
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const { session, loading } = useAuthSession();
  const myPhone = resolveUserPhone(session?.user);

  if (loading) {
    return (
      <div className="flex h-60 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!isSuperAdminPhone(myPhone)) {
    return (
      <div>
        <PageHeader title="账号管理" description="仅超级管理员可访问" />
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            当前账号无权访问此页面。
          </CardContent>
        </Card>
      </div>
    );
  }
  return <AdminUsersContent />;
}

function AdminUsersContent() {
  const qc = useQueryClient();
  const fetchList = useServerFn(listUsersFn);
  const createFn = useServerFn(createUserFn);
  const resetFn = useServerFn(resetUserPasswordFn);
  const deleteFn = useServerFn(deleteUserFn);
  const updateNameFn = useServerFn(updateUserNameFn);

  const list = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => fetchList(),
  });

  const createMut = useMutation({
    mutationFn: (vars: { phone: string; password: string; name: string }) => createFn({ data: vars }),
    onSuccess: () => {
      toast.success("账号已创建");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "创建失败"),
  });

  const resetMut = useMutation({
    mutationFn: (vars: { userId: string; password: string }) => resetFn({ data: vars }),
    onSuccess: () => {
      toast.success("密码已重置，用户下次登录需修改");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "重置失败"),
  });

  const deleteMut = useMutation({
    mutationFn: (userId: string) => deleteFn({ data: { userId } }),
    onSuccess: () => {
      toast.success("账号已删除");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "删除失败"),
  });

  const updateNameMut = useMutation({
    mutationFn: (vars: { userId: string; name: string }) => updateNameFn({ data: vars }),
    onSuccess: () => {
      toast.success("姓名已更新");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "更新失败"),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="账号管理"
        description="由超级管理员添加和维护登录账号，用户首次登录需修改密码"
        actions={<CreateUserDialog onSubmit={(v) => createMut.mutateAsync(v)} />}
      />

      <Card>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : list.error ? (
            <div className="p-6 text-sm text-destructive">
              加载失败：{(list.error as Error).message}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>姓名</TableHead>
                  <TableHead>手机号 / 邮箱</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead>最近登录</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(list.data ?? []).map((u) => {
                  const isSA = isSuperAdminPhone(u.phone);
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">
                        {u.name ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        {u.phone ? (
                          <span>{u.phone}</span>
                        ) : (
                          <span className="text-muted-foreground">{u.email}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {isSA ? (
                          <Badge className="gap-1 bg-primary/10 text-primary hover:bg-primary/20">
                            <ShieldCheck className="h-3 w-3" />
                            超级管理员
                          </Badge>
                        ) : (
                          <Badge variant="secondary">普通用户</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {u.must_change_password ? (
                          <Badge variant="outline" className="text-amber-600">
                            待修改密码
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">
                            正常
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(u.created_at).toLocaleString("zh-CN")}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {u.last_sign_in_at
                          ? new Date(u.last_sign_in_at).toLocaleString("zh-CN")
                          : "从未登录"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <ResetPasswordButton
                            userId={u.id}
                            label={u.phone ?? u.email ?? ""}
                            onSubmit={(p) => resetMut.mutateAsync({ userId: u.id, password: p })}
                          />
                          {!isSA && (
                            <DeleteUserButton
                              label={u.phone ?? u.email ?? ""}
                              onConfirm={() => deleteMut.mutateAsync(u.id)}
                            />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {(list.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                      暂无账号
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        超级管理员（写死在代码中）：{SUPER_ADMIN_PHONES.join("、")}。如需调整请联系开发修改 <code>src/lib/auth-config.ts</code>。
      </p>
    </div>
  );
}

function CreateUserDialog({ onSubmit }: { onSubmit: (v: { phone: string; password: string; name: string }) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("请填写姓名");
      return;
    }
    if (!PHONE_REGEX.test(phone)) {
      toast.error("手机号格式不正确");
      return;
    }
    if (password.length < 6) {
      toast.error("初始密码至少 6 位");
      return;
    }
    setLoading(true);
    try {
      await onSubmit({ phone, password, name: name.trim() });
      setOpen(false);
      setName("");
      setPhone("");
      setPassword("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-1.5">
          <UserPlus className="h-4 w-4" />
          新增账号
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新增账号</DialogTitle>
          <DialogDescription>
            录入用户姓名、手机号与初始密码，用户首次登录系统会要求修改密码。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-name">姓名</Label>
            <Input
              id="new-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="张三"
              maxLength={50}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-phone">手机号</Label>
            <Input
              id="new-phone"
              type="tel"
              inputMode="numeric"
              maxLength={11}
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
              placeholder="13800138000"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="init-pwd">初始密码</Label>
            <Input
              id="init-pwd"
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 6 位，告知给用户"
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              <Plus className="h-4 w-4" />
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordButton({
  userId,
  label,
  onSubmit,
}: {
  userId: string;
  label: string;
  onSubmit: (password: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [pwd, setPwd] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pwd.length < 6) {
      toast.error("密码至少 6 位");
      return;
    }
    setLoading(true);
    try {
      await onSubmit(pwd);
      setOpen(false);
      setPwd("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8 gap-1">
          <RotateCcw className="h-3.5 w-3.5" />
          重置密码
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>
            为 <span className="font-medium">{label}</span> 设置新密码，对方下次登录时会被要求再次修改。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`reset-${userId}`}>新密码</Label>
            <Input
              id={`reset-${userId}`}
              type="text"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="至少 6 位"
              required
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              确认重置
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteUserButton({ label, onConfirm }: { label: string; onConfirm: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 gap-1 text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-3.5 w-3.5" />
        删除
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除账号</AlertDialogTitle>
          <AlertDialogDescription>
            确定要删除 <span className="font-medium">{label}</span> 吗？此操作不可恢复。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={loading}
            onClick={async (e) => {
              e.preventDefault();
              setLoading(true);
              try {
                await onConfirm();
                setOpen(false);
              } finally {
                setLoading(false);
              }
            }}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            确认删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
