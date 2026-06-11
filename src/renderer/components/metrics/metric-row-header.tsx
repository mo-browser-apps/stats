import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { MetricState } from "@/domain/metric-view";

/**
 * Shared chrome for the metric rows: the header (icon + uppercase label, with
 * `children` on the right), the big-value-small-unit headline, and the hover
 * tooltip pill used by the CPU graph and the memory meter.
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

/**
 * Headline value color per metric state: quiet white while ok, the status hue
 * once a usage-thresholded metric runs hot, muted for placeholders.
 */
export const VALUE_COLOR_BY_STATE: Record<MetricState, string> = {
  ok: "text-foreground",
  elevated: "text-warning",
  critical: "text-destructive",
  pending: "text-muted-foreground",
  unavailable: "text-muted-foreground",
};

/** A row's headline value: the number large, the unit small and muted. */
export function ValueUnit({ value, unit, valueClassName }: { value: string; unit?: string; valueClassName?: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className={cn("text-base font-medium tabular-nums leading-none", valueClassName ?? "text-foreground")}>
        {value}
      </span>
      {unit ? <span className="text-[13px] font-light leading-none text-muted-foreground">{unit}</span> : null}
    </span>
  );
}

/**
 * A small tooltip pill horizontally centered at `leftPercent` of its relative
 * parent (clamped off the edges); the caller positions it vertically.
 */
export function MeterTooltip({
  leftPercent,
  clampPercent = 8,
  className,
  children,
}: {
  leftPercent: number
  /** Smallest distance (percent) the pill center keeps from either edge; size it to half the pill's width. */
  clampPercent?: number
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-popover-foreground shadow-sm",
        className,
      )}
      style={{ left: `${Math.min(100 - clampPercent, Math.max(clampPercent, leftPercent))}%` }}
    >
      {children}
    </div>
  );
}
