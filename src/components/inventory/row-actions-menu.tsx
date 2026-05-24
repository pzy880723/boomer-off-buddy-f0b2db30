import { useState, type ReactNode } from "react";
import { MoreHorizontal, Pencil, Trash2, Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
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

export function RowActionsMenu({
  onEdit,
  onDelete,
  deleteTitle = "确认删除？",
  deleteDescription,
  className = "",
  trigger,
}: {
  onEdit: () => void;
  onDelete: () => Promise<unknown>;
  deleteTitle?: string;
  deleteDescription?: ReactNode;
  className?: string;
  trigger?: ReactNode;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const mut = useMutation({
    mutationFn: onDelete,
    onSuccess: () => {
      toast.success("已删除");
      setConfirmOpen(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const stop = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={stop as never}>
          {trigger ?? (
            <Button
              variant="ghost"
              size="icon"
              className={`h-7 w-7 ${className}`}
              aria-label="操作"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={stop as never}>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onEdit();
            }}
          >
            <Pencil className="mr-2 h-3.5 w-3.5" /> 编辑
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(e) => {
              e.preventDefault();
              setConfirmOpen(true);
            }}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent onClick={stop as never}>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteTitle}</AlertDialogTitle>
            {deleteDescription && (
              <AlertDialogDescription>{deleteDescription}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mut.isPending}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={mut.isPending}
              onClick={(e) => {
                e.preventDefault();
                mut.mutate();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {mut.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
