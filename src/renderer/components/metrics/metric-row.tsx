import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { isLive, type MetricState } from "@/domain/metric-view";
import { UNAVAILABLE_TEXT } from "@/lib/format";

/**
 * One metric as a horizontal row.
 */
export interface MetricRowProps {
  icon: LucideIcon;
  label: string;
  /** Presentation state; drives value color and meter fill. */
  state: MetricState;
  /** Primary value string, already formatted. Ignored when not live. */
  value?: string;
  /** Optional detail line (e.g. "10.2 / 16 GB" or a CPU model). */
  detail?: string;
  /** When provided, a hairline meter is shown with a marker dot at value% (0-100). */
  percent?: number;
}

const VALUE_COLOR_BY_STATE: Record<MetricState, string> = {
  ok: "text-foreground",
  elevated: "text-warning",
  critical: "text-destructive",
  pending: "text-muted-foreground",
  unavailable: "text-muted-foreground",
};

/**
 * Meter fill + marker color, mirroring the value color so state never relies on
 * the meter alone.
 */
const FILL_BY_STATE: Record<MetricState, string> = {
  ok: "bg-success shadow-[0_0_4px_var(--success)]",
  elevated: "bg-warning shadow-[0_0_4px_var(--warning)]",
  critical: "bg-destructive shadow-[0_0_4px_var(--destructive)]",
  pending: "bg-muted-foreground/30",
  unavailable: "bg-muted-foreground/30",
};

export function MetricRow({ icon: Icon, label, state, value, detail, percent }: MetricRowProps) {
  const live = isLive(state);
  const primaryText = live && value ? value : state === "pending" ? "--" : UNAVAILABLE_TEXT;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-3.5 w-3.5 shrink-0 self-center" strokeWidth={1.75} aria-hidden="true" />
          <span className="text-[11px] font-light uppercase tracking-[0.18em]">{label}</span>
        </span>
        <span className={cn("text-2xl font-medium tabular-nums leading-none", VALUE_COLOR_BY_STATE[state])}>
          {primaryText}
        </span>
      </div>
      <Meter label={label} state={state} percent={percent} />
      <span className="h-3.5 truncate text-[11px] text-muted-foreground/80 tabular-nums">
        {live && detail ? detail : null}
      </span>
    </div>
  );
}

/**
 * 1px track with an absolutely positioned fill and a marker dot straddling the
 * fill end. The value is mirrored onto ARIA so the usage reads without depending
 * on color.
 */
function Meter({ label, state, percent }: { label: string; state: MetricState; percent?: number }) {
  const live = isLive(state);
  const hasValue = live && percent !== undefined && Number.isFinite(percent);
  const clamped = hasValue ? Math.min(100, Math.max(0, percent)) : 0;

  if (!hasValue) {
    return <div className="relative h-px w-full" aria-hidden="true" />;
  }

  return (
    <div
      className="relative h-px w-full bg-track"
      role="progressbar"
      aria-label={`${label} usage`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div
        className={cn("absolute inset-y-0 left-0 transition-[width] duration-150 ease-out", FILL_BY_STATE[state])}
        style={{ width: `${clamped}%` }}
      />
      <span
        className={cn("absolute top-1/2 h-1 w-1 -translate-y-1/2 rounded-full", FILL_BY_STATE[state])}
        style={{ left: `calc(${clamped}% - 2px)` }}
        aria-hidden="true"
      />
    </div>
  );
}
