import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

export function PageHeader({
  title,
  description,
  actions,
  meta,
  backTo,
  backLabel,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b pb-5">
      <div className="min-w-0">
        {backTo && (
          <Link
            to={backTo}
            className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {backLabel ?? "返回"}
          </Link>
        )}
        <div className="flex items-center gap-2">
          <span className="h-5 w-1 rounded-full bg-gradient-brand" />
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        </div>
        {description && (
          <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
        )}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
