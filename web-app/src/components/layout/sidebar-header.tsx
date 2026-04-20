import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function SidebarHeader({
  title,
  subtitle,
  right,
  className,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-10 items-center justify-between gap-2 border-b border-border/70 bg-background/60 px-3 backdrop-blur",
        className
      )}
    >
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {subtitle && (
          <span className="truncate text-[10px] text-muted-foreground/70">
            {subtitle}
          </span>
        )}
      </div>
      {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
    </div>
  );
}
