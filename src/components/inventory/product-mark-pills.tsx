// 标题下状态胶囊区：销售状态/成色 + 特色印章 + 全部提示标签（自动换行，不截断风险提示）。不是分类 facets。
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { productMarkLabels } from "@/lib/commerce/product-marks";
import { cn } from "@/lib/utils";

export function ProductStatusPills(props: {
  sku: { featured_stamp?: unknown; notice_tags?: unknown };
  leading?: ReactNode;
  className?: string;
}) {
  const marks = productMarkLabels(props.sku);
  if (!props.leading && marks.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", props.className)}>
      {props.leading}
      {marks.map((m) =>
        m.kind === "stamp" ? (
          <Badge key={m.key} className="bg-accent text-accent-foreground text-[10px]">{m.label}</Badge>
        ) : (
          <Badge key={m.key} variant="outline" className="border-destructive/40 text-destructive text-[10px]">{m.label}</Badge>
        ),
      )}
    </div>
  );
}
