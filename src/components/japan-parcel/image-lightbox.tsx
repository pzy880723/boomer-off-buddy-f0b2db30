import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { toThumbUrl } from "@/lib/image";

/**
 * 点击缩略图后弹窗放大查看。
 * 缩略图走 Supabase render/image 接口（webp、按 thumbWidth 缩放），弹窗里加载原图。
 */
export function ClickableThumb({
  src,
  alt,
  className,
  loading = "lazy",
  thumbWidth = 256,
}: {
  src: string;
  alt?: string;
  className?: string;
  loading?: "lazy" | "eager";
  thumbWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const thumb = toThumbUrl(src, thumbWidth) ?? src;
  return (
    <>
      <img
        src={thumb}
        alt={alt ?? ""}
        loading={loading}
        decoding="async"
        className={`${className ?? ""} cursor-zoom-in`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-[92vw] border-none bg-transparent p-0 shadow-none sm:max-w-[92vw]"
          onClick={() => setOpen(false)}
        >
          {open && (
            <img
              src={src}
              alt={alt ?? ""}
              loading="eager"
              className="mx-auto max-h-[90vh] w-auto max-w-full rounded object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
