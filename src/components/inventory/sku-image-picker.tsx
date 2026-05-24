import { useRef, useState } from "react";
import { Upload, X, Loader2, ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { uploadSkuImage } from "@/lib/image-upload";

export function SkuImagePicker({
  value,
  onChange,
  mobile,
}: {
  value: string;
  onChange: (url: string) => void;
  mobile?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

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
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
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
            <Upload className="h-3 w-3" /> 上传图片
          </span>
        </>
      )}
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
    </button>
  );
}
