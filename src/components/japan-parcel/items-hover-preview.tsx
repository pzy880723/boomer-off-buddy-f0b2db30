import { ImageIcon } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ClickableThumb } from "./image-lightbox";
import { toThumbUrl } from "@/lib/image";

export interface PreviewItem {
  id: string;
  item_title: string | null;
  item_title_cn: string | null;
  item_image_url: string | null;
}

export function ItemsHoverPreview({
  items,
  onClick,
}: {
  items: PreviewItem[];
  onClick?: () => void;
}) {
  const first = items[0];
  const cover = first?.item_image_url ?? null;
  const extra = items.slice(1);

  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClick?.();
          }}
          className="relative block h-11 w-11 overflow-hidden rounded-md ring-1 ring-border transition-all hover:scale-[1.05] hover:ring-primary/40"
          aria-label="预览所有商品"
        >
          {cover ? (
            <img src={toThumbUrl(cover, 128) ?? cover} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-muted">
              <ImageIcon className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
          {items.length > 1 && (
            <span className="absolute bottom-0 right-0 rounded-tl-md bg-black/75 px-1 text-[9px] font-medium leading-tight text-white">
              +{items.length - 1}
            </span>
          )}
        </button>
      </HoverCardTrigger>
      {items.length > 0 && (
        <HoverCardContent side="right" align="start" className="w-72 p-2">
          <div className="grid grid-cols-3 gap-2">
            {[first, ...extra].filter(Boolean).map((it) => (
              <div key={it!.id} className="space-y-1">
                {it!.item_image_url ? (
                  <ClickableThumb
                    src={it!.item_image_url}
                    thumbWidth={200}
                    className="aspect-square w-full rounded object-cover"
                  />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center rounded bg-muted">
                    <ImageIcon className="h-4 w-4 text-muted-foreground" />
                  </div>
                )}
                <div className="line-clamp-2 text-[10px] leading-tight">
                  {it!.item_title_cn || it!.item_title || "—"}
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={onClick}
            className="mt-2 w-full rounded bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
          >
            查看完整包裹卡片 →
          </button>
        </HoverCardContent>
      )}
    </HoverCard>
  );
}
