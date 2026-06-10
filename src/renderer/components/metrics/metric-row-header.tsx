import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared row chrome: the icon + uppercase label, with `children` on the right.
 */
export function MetricRowHeader({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0 self-center" strokeWidth={1.75} aria-hidden="true" />
        <span className="text-[11px] font-light uppercase tracking-widest">{label}</span>
      </span>
      {children}
    </div>
  );
}
