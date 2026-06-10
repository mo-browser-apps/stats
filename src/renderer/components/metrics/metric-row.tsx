import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { isLive, type MetricState } from "@/domain/metric-view";

export const VALUE_COLOR_BY_STATE: Record<MetricState, string> = {
  ok: "text-foreground",
  elevated: "text-warning",
  critical: "text-destructive",
  pending: "text-muted-foreground",
  unavailable: "text-muted-foreground",
};

const FILL_BY_STATE: Record<MetricState, string> = {
  ok: "bg-success",
  elevated: "bg-warning",
  critical: "bg-destructive",
  pending: "bg-muted-foreground/30",
  unavailable: "bg-muted-foreground/30",
};

/** Shared row chrome: the icon + uppercase label, with `children` on the right. */
export function MetricRowHeader({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0 self-center" strokeWidth={1.75} aria-hidden="true" />
        <span className="text-[11px] font-light uppercase tracking-[0.18em]">{label}</span>
      </span>
      {children}
    </div>
  );
}

/** Rounded rail with a fill whose width encodes the value; mirrored onto ARIA. */
export function Meter({ label, state, percent }: { label: string; state: MetricState; percent?: number }) {
  const live = isLive(state);
  const hasValue = live && percent !== undefined && Number.isFinite(percent);
  const clamped = hasValue ? Math.min(100, Math.max(0, percent)) : 0;

  if (!hasValue) {
    return <div className="relative h-1 w-full" aria-hidden="true" />;
  }

  return (
    <div
      className="relative h-1 w-full overflow-hidden rounded-full bg-track"
      role="progressbar"
      aria-label={`${label} usage`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div
        className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-150 ease-out", FILL_BY_STATE[state])}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
