import { useState } from "react";
import { Tags } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * SKU 多图画廊：主图 + 缩略图横排，点击主图弹 Lightbox。
 * images 优先来自 ERP/Handheld API 返回的签名好的 URL 列表；
 * 空数组时退回 fallbackUrl，再空就显示占位。
 */
export function SkuImageGallery({
  images,
  fallbackUrl,
  alt,
  className,
}: {
  images: string[];
  fallbackUrl?: string | null;
  alt: string;
  className?: string;
}) {
  const list = images.length > 0 ? images : fallbackUrl ? [fallbackUrl] : [];
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const cur = list[active];

  if (list.length === 0) {
    return (
      <div
        className={cn(
          "flex aspect-square w-full items-center justify-center rounded-lg border bg-muted text-muted-foreground",
          className,
        )}
      >
        <Tags className="h-10 w-10" />
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full overflow-hidden rounded-lg border bg-muted"
        aria-label="放大查看"
      >
        <img
          src={cur}
          alt={alt}
          loading="eager"
          decoding="async"
          className="aspect-square w-full cursor-zoom-in object-cover"
        />
      </button>
      {list.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {list.map((src, i) => (
            <button
              key={`${src}-${i}`}
              type="button"
              onClick={() => setActive(i)}
              className={cn(
                "h-14 w-14 shrink-0 overflow-hidden rounded border bg-muted transition",
                i === active ? "ring-2 ring-primary" : "opacity-80 hover:opacity-100",
              )}
              aria-label={`第 ${i + 1} 张`}
            >
              <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-[95vw] border-none bg-transparent p-0 shadow-none sm:max-w-[95vw]"
          onClick={() => setOpen(false)}
        >
          {open && cur && (
            <img
              src={cur}
              alt={alt}
              loading="eager"
              className="mx-auto max-h-[92vh] w-auto max-w-full rounded object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
