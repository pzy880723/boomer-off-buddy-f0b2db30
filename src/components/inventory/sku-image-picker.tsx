import { useRef, useState } from "react";
import { Upload, X, Loader2, ImageIcon, Plus, Sparkles, Search } from "lucide-react";
import { toast } from "sonner";
import { uploadSkuImage } from "@/lib/image-upload";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { SkuImageSourceDialog } from "./sku-image-source-dialog";

export function SkuImagePicker({
  value,
  onChange,
  mobile,
  defaultName,
  defaultCategoryLabel,
}: {
  value: string;
  onChange: (url: string) => void;
  mobile?: boolean;
  defaultName?: string;
  defaultCategoryLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTab, setDialogTab] = useState<"ai" | "search">("ai");

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const url = await uploadSkuImage(file);
      onChange(url);
    } catch (e) {
      toast.error((e as Error).message || "上传失败");
    } finally {
      setUploading(false);
    }
  };

  if (value) {
    return (
      <div className="relative h-32 w-32 overflow-hidden rounded-lg border bg-muted">
        <img src={value} alt="" className="h-full w-full object-cover" />
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-foreground shadow hover:bg-background"
          aria-label="移除图片"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={uploading}
            className="flex h-32 w-32 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed bg-muted/30 text-xs text-muted-foreground transition hover:bg-muted/60 disabled:opacity-60"
          >
            {uploading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                上传中…
              </>
            ) : (
              <>
                <ImageIcon className="h-5 w-5" />
                <span className="inline-flex items-center gap-1">
                  <Plus className="h-3 w-3" /> 添加图片
                </span>
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => inputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />本地上传
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setDialogTab("ai"); setDialogOpen(true); }}>
            <Sparkles className="mr-2 h-4 w-4" />AI 生成
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setDialogTab("search"); setDialogOpen(true); }}>
            <Search className="mr-2 h-4 w-4" />在线搜索
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={mobile ? "environment" : undefined}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) handleFile(f);
        }}
      />

      <SkuImageSourceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialTab={dialogTab}
        defaultName={defaultName}
        defaultCategoryLabel={defaultCategoryLabel}
        onPick={onChange}
      />
    </>
  );
}
